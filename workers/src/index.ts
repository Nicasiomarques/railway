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
import { InMemoryBackupProvider } from "./backup/in-memory.js";
import { PostgresBackupStore } from "./backup/postgres-store.js";
import { createBackupWorker } from "./backup/worker.js";
import { LocalFsObjectStorageProvider } from "./storage/local-fs.js";
import { PostgresWebhookStore } from "./webhooks/postgres-store.js";
import { createWebhookWorker } from "./webhooks/worker.js";

// Explicit runtime choice: "k8s" creates workloads on the cluster; "memory" only simulates.
// Without the choice the process doesn't start, so it doesn't appear to be running while doing nothing.
const runtimeKind = process.env.RECONCILER_RUNTIME;
if (runtimeKind !== "k8s" && runtimeKind !== "memory") {
  throw new Error("Set RECONCILER_RUNTIME=k8s (cluster) or RECONCILER_RUNTIME=memory (simulated).");
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");

const keyring = loadKeyringFromEnv();
const { db, pool } = createDb(process.env.DATABASE_URL);
const connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

// Repository builds need a registry that the nodes can also see (e.g.: k3d-railway-reg:5000).
const buildRegistry = process.env.BUILD_REGISTRY;
if (runtimeKind === "k8s" && !buildRegistry) throw new Error("BUILD_REGISTRY is required with RECONCILER_RUNTIME=k8s.");

// BUILD_EGRESS_ALLOW="172.24.0.2/32:5000,172.24.0.1/32:8189": outbound destinations allowed into the private network.
function parseEgressAllow(raw: string | undefined): { cidr: string; port: number }[] {
  if (!raw) return [];
  return raw.split(",").map((entry) => {
    const [cidr, port] = entry.trim().split(":");
    if (!cidr || !port || !Number.isInteger(Number(port))) throw new Error(`malformed BUILD_EGRESS_ALLOW: ${entry}`);
    return { cidr, port: Number(port) };
  });
}

// One runtime per process: the reconciler and the provisioning saga share the same client.
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
          // Default: BuildKit sandbox on, under gVisor (RuntimeClass). See infra/spike/gvisor.
          // BUILD_PROCESS_SANDBOX=none turns off the process sandbox; BUILD_RUNTIME_CLASS="" uses the default runtime.
          processSandbox: process.env.BUILD_PROCESS_SANDBOX === "none" ? "none" : "process",
          runtimeClass: process.env.BUILD_RUNTIME_CLASS ?? "gvisor",
          // Native snapshotter: rootless BuildKit's FUSE overlay doesn't work under gVisor.
          buildkitdFlags: process.env.BUILD_BUILDKITD_FLAGS ?? "--oci-worker-snapshotter=native",
          egressAllow: parseEgressAllow(process.env.BUILD_EGRESS_ALLOW),
        })
      : undefined,
});

// Domain/TLS (architecture.md §6 and §8): there's no real DNS/ACME implementation yet, so the
// provider is always the simulated one, regardless of the reconciler's runtime.
const domainWorker = createDomainWorker(connection, {
  store: new PostgresDomainStore(db),
  provider: new InMemoryDomainProvider(),
});

// Volume backups (architecture.md §6): the backup provider still only simulates the volume
// snapshot / logical dump step, but it now ships a real dump (volumeId + timestamp) to object
// storage through LocalFsObjectStorageProvider (OBJECT_STORAGE_DIR, default
// /tmp/railway-like-object-storage) instead of only an in-memory Map. No daily schedule is wired
// here yet either — see workers/src/backup/worker.ts (scheduleDailyBackups) for how that would be
// connected.
const backupWorker = createBackupWorker(connection, {
  store: new PostgresBackupStore(db),
  provider: new InMemoryBackupProvider(new LocalFsObjectStorageProvider()),
});

// Outbound webhooks (roadmap.md Phase 5): delivery via Node's native fetch (FetchWebhookTransport,
// the default when `transport` is omitted). The API's queue.ts (createWebhookQueue) does the
// subscription matching and enqueues one deliver-webhook job per match; this worker just sends it.
const webhookWorker = createWebhookWorker(connection, {
  store: new PostgresWebhookStore(db),
});

console.log(`workers started (Postgres store, runtime ${runtimeKind})`);

async function shutdown(): Promise<void> {
  await worker.close();
  await domainWorker.close();
  await backupWorker.close();
  await webhookWorker.close();
  await connection.quit();
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
