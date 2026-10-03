import { Redis } from "ioredis";
import { createDb, loadKeyringFromEnv } from "@railway-like/db";
import { createEnvLoader } from "./reconciler/env-loader.js";
import { PostgresDeploymentStore } from "./reconciler/postgres-store.js";
import { createReconcileWorker } from "./reconciler/worker.js";
import { InMemoryRuntime } from "./runtime/in-memory.js";
import { K8sRuntime } from "./runtime/k8s.js";
import { K8sBuilder } from "./build/k8s-builder.js";
import { PostgresEnvironmentStore } from "./provisioning/postgres-store.js";
import { InMemoryDomainProvider } from "./domain/in-memory.js";
import { PostgresDomainStore } from "./domain/postgres-store.js";
import { createDomainWorker } from "./domain/worker.js";

// Escolha explícita do runtime: "k8s" cria workloads no cluster; "memory" só simula.
// Sem a escolha o processo não sobe, para não parecer operar sem fazer nada.
const runtimeKind = process.env.RECONCILER_RUNTIME;
if (runtimeKind !== "k8s" && runtimeKind !== "memory") {
  throw new Error("Defina RECONCILER_RUNTIME=k8s (cluster) ou RECONCILER_RUNTIME=memory (simulado).");
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL é obrigatória.");

const keyring = loadKeyringFromEnv();
const { db, pool } = createDb(process.env.DATABASE_URL);
const connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

// Builds de repositório precisam de um registry que os nós também enxergam (ex.: k3d-railway-reg:5000).
const buildRegistry = process.env.BUILD_REGISTRY;
if (runtimeKind === "k8s" && !buildRegistry) throw new Error("BUILD_REGISTRY é obrigatória com RECONCILER_RUNTIME=k8s.");

// BUILD_EGRESS_ALLOW="172.24.0.2/32:5000,172.24.0.1/32:8189": saídas liberadas para dentro da rede privada.
function parseEgressAllow(raw: string | undefined): { cidr: string; port: number }[] {
  if (!raw) return [];
  return raw.split(",").map((entry) => {
    const [cidr, port] = entry.trim().split(":");
    if (!cidr || !port || !Number.isInteger(Number(port))) throw new Error(`BUILD_EGRESS_ALLOW mal formada: ${entry}`);
    return { cidr, port: Number(port) };
  });
}

// Um runtime por processo: o reconciliador e a saga de provisionamento compartilham o mesmo cliente.
const runtime = runtimeKind === "k8s" ? K8sRuntime.fromContext(process.env.K8S_CONTEXT) : new InMemoryRuntime();

const worker = createReconcileWorker(connection, {
  store: new PostgresDeploymentStore(db, createEnvLoader(db, keyring)),
  runtime,
  provisioning: { store: new PostgresEnvironmentStore(db), runtime },
  builder:
    runtimeKind === "k8s" && buildRegistry
      ? K8sBuilder.fromContext(process.env.K8S_CONTEXT, {
          registry: buildRegistry,
          namespace: process.env.BUILD_NAMESPACE ?? "builds",
          timeoutSeconds: Number(process.env.BUILD_TIMEOUT_SECONDS ?? 900),
          // Padrão: sandbox do BuildKit ligado, sob gVisor (RuntimeClass). Ver infra/spike/gvisor.
          // BUILD_PROCESS_SANDBOX=none desliga o sandbox de processo; BUILD_RUNTIME_CLASS="" usa o runtime padrão.
          processSandbox: process.env.BUILD_PROCESS_SANDBOX === "none" ? "none" : "process",
          runtimeClass: process.env.BUILD_RUNTIME_CLASS ?? "gvisor",
          // Snapshotter nativo: o overlay com FUSE do BuildKit rootless não funciona sob gVisor.
          buildkitdFlags: process.env.BUILD_BUILDKITD_FLAGS ?? "--oci-worker-snapshotter=native",
          egressAllow: parseEgressAllow(process.env.BUILD_EGRESS_ALLOW),
        })
      : undefined,
});

// Domínio/TLS (architecture.md §6 e §8): ainda não existe implementação real de DNS/ACME, então
// o provider é sempre o simulado, independente do runtime do reconciliador.
const domainWorker = createDomainWorker(connection, {
  store: new PostgresDomainStore(db),
  provider: new InMemoryDomainProvider(),
});

console.log(`workers iniciados (store Postgres, runtime ${runtimeKind})`);

async function shutdown(): Promise<void> {
  await worker.close();
  await domainWorker.close();
  await connection.quit();
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
