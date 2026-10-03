import { describe, expect, it } from "vitest";
import { namespaceFor, workloadName } from "../runtime/adapter.js";
import { InMemoryRuntime } from "../runtime/in-memory.js";
import { InMemoryDeploymentStore } from "./in-memory-store.js";
import { handleReconcileJob, reconcileInstance } from "./reconcile.js";
import { PermanentError } from "./errors.js";
import { InMemoryBuilder } from "../build/in-memory-builder.js";
import type { DeploymentRecord } from "./store.js";

const INSTANCE = "inst-1";
const ENVIRONMENT = "env-1";
const REF = { name: workloadName(INSTANCE), namespace: namespaceFor(ENVIRONMENT) };
const IMAGE_V1 = "registry.local/app@sha256:aaa";
const IMAGE_V2 = "registry.local/app@sha256:bbb";

function deployment(overrides: Partial<DeploymentRecord> & Pick<DeploymentRecord, "id" | "status">): DeploymentRecord {
  return {
    serviceInstanceId: INSTANCE,
    environmentId: ENVIRONMENT,
    versionNo: 1,
    imageDigest: IMAGE_V1,
    commitSha: null,
    repoUrl: null,
    rootDir: "/",
    env: { PORT: "3000" },
    replicas: 1,
    ...overrides,
  };
}

function setup() {
  const store = new InMemoryDeploymentStore();
  const runtime = new InMemoryRuntime();
  const builder = new InMemoryBuilder();
  return { store, runtime, builder, deps: { store, runtime, builder } };
}

describe("reconcileInstance", () => {
  it("fica ocioso quando não há deployment ativo", async () => {
    const { deps, store } = setup();
    store.add(deployment({ id: "d1", status: "Running" }));
    expect(await reconcileInstance(deps, INSTANCE)).toEqual({ kind: "idle" });
  });

  it("aplica o workload, move para HealthChecking e fica pendente até as réplicas ficarem prontas", async () => {
    const { deps, store, runtime } = setup();
    store.add(deployment({ id: "d1", status: "Deploying" }));

    const result = await reconcileInstance(deps, INSTANCE);

    expect(result).toEqual({ kind: "pending", deploymentId: "d1", reason: expect.any(String), phase: "HealthChecking" });
    expect(store.get("d1")!.status).toBe("HealthChecking");
    expect(await runtime.getStatus(REF)).toMatchObject({ image: IMAGE_V1, readyReplicas: 0 });
  });

  it("promove para Running quando o health check passa", async () => {
    const { deps, store, runtime } = setup();
    store.add(deployment({ id: "d1", status: "Deploying" }));
    await reconcileInstance(deps, INSTANCE);
    runtime.markReady(workloadName(INSTANCE));

    const result = await reconcileInstance(deps, INSTANCE);

    expect(result).toEqual({ kind: "converged", deploymentId: "d1" });
    expect(store.get("d1")!.status).toBe("Running");
  });

  it("rollout: o Running anterior só vira Superseded depois que o novo fica pronto", async () => {
    const { deps, store, runtime } = setup();
    store.add(deployment({ id: "d1", status: "Running", versionNo: 1 }));
    store.add(deployment({ id: "d2", status: "Deploying", versionNo: 2, imageDigest: IMAGE_V2 }));

    await reconcileInstance(deps, INSTANCE);
    // Enquanto o novo não está pronto, o antigo segue Running.
    expect(store.get("d1")!.status).toBe("Running");
    expect(store.get("d2")!.status).toBe("HealthChecking");

    runtime.markReady(workloadName(INSTANCE));
    await reconcileInstance(deps, INSTANCE);

    expect(store.get("d2")!.status).toBe("Running");
    expect(store.get("d1")!.status).toBe("Superseded");
  });

  it("workload com a imagem antiga não conta como pronto", async () => {
    const { deps, store, runtime } = setup();
    store.add(deployment({ id: "d1", status: "Running", versionNo: 1 }));
    store.add(deployment({ id: "d2", status: "Deploying", versionNo: 2, imageDigest: IMAGE_V2 }));
    // O runtime ainda roda a v1, pronta.
    await runtime.applyWorkload({ name: REF.name, namespace: REF.namespace, image: IMAGE_V1, env: { PORT: "3000" }, replicas: 1 });
    runtime.markReady(workloadName(INSTANCE));

    const result = await reconcileInstance(deps, INSTANCE);

    expect(result.kind).toBe("pending");
    expect(store.get("d1")!.status).toBe("Running");
  });

  it("é idempotente: rodar de novo depois de convergido não muda nada", async () => {
    const { deps, store, runtime } = setup();
    store.add(deployment({ id: "d1", status: "Deploying" }));
    await reconcileInstance(deps, INSTANCE);
    runtime.markReady(workloadName(INSTANCE));
    await reconcileInstance(deps, INSTANCE);
    const eventsAfterConverge = store.events.length;

    expect(await reconcileInstance(deps, INSTANCE)).toEqual({ kind: "idle" });
    expect(store.events.length).toBe(eventsAfterConverge);
  });

});

describe("handleReconcileJob (retries e falha final)", () => {
  it("pendência com orçamento sobrando lança erro para o BullMQ re-tentar", async () => {
    const { deps, store } = setup();
    store.add(deployment({ id: "d1", status: "Deploying" }));

    await expect(
      handleReconcileJob(deps, { serviceInstanceId: INSTANCE }, { attemptsMade: 0, maxAttempts: 3 }),
    ).rejects.toThrow(/tentativa 1 de 3/);
    expect(store.get("d1")!.status).toBe("HealthChecking");
  });

  it("na última tentativa, o deployment vai para Failed com o motivo gravado", async () => {
    const { deps, store } = setup();
    store.add(deployment({ id: "d1", status: "Deploying" }));

    const result = await handleReconcileJob(deps, { serviceInstanceId: INSTANCE }, { attemptsMade: 2, maxAttempts: 3 });

    expect(result).toEqual({ kind: "failed", deploymentId: "d1" });
    expect(store.get("d1")!.status).toBe("Failed");
    const failure = store.events.at(-1)!;
    expect(failure.reason).toMatch(/health check não passou após 3 tentativas/);
  });

  it("depois de Running, reconciliar é ocioso e não rebaixa o deployment", async () => {
    const { deps, store, runtime } = setup();
    store.add(deployment({ id: "d1", status: "Deploying" }));
    await reconcileInstance(deps, INSTANCE);
    runtime.markReady(workloadName(INSTANCE));
    await reconcileInstance(deps, INSTANCE);

    expect(await reconcileInstance(deps, INSTANCE)).toEqual({ kind: "idle" });
    expect(store.get("d1")!.status).toBe("Running");
  });
});

describe("handleReconcileJob: classificação de falhas", () => {
  const budget = { attemptsMade: 0, maxAttempts: 3 };
  const lastAttempt = { attemptsMade: 2, maxAttempts: 3 };

  it("deployment sem image_digest falha na hora, sem gastar retries", async () => {
    const { deps, store } = setup();
    store.add(deployment({ id: "d1", status: "Deploying", imageDigest: null }));

    const result = await handleReconcileJob(deps, { serviceInstanceId: INSTANCE }, budget);

    expect(result).toEqual({ kind: "failed", deploymentId: "d1" });
    expect(store.get("d1")!.status).toBe("Failed");
    expect(store.events.at(-1)!.reason).toMatch(/sem image_digest/);
  });

  it("PermanentError vinda do runtime falha o deployment mesmo com retries sobrando", async () => {
    const store = new InMemoryDeploymentStore();
    const runtime = {
      applyWorkload: async () => {
        throw new PermanentError("spec rejeitada pelo cluster", "d1");
      },
      getStatus: async () => null,
      tailLogs: async function* () {},
    };
    store.add(deployment({ id: "d1", status: "Deploying" }));

    const result = await handleReconcileJob({ store, runtime }, { serviceInstanceId: INSTANCE }, budget);

    expect(result).toEqual({ kind: "failed", deploymentId: "d1" });
    expect(store.get("d1")!.status).toBe("Failed");
  });

  it("erro transitório com retries sobrando é relançado e o deployment fica como estava", async () => {
    const store = new InMemoryDeploymentStore();
    const runtime = {
      applyWorkload: async () => {
        throw new Error("api do cluster fora do ar");
      },
      getStatus: async () => null,
      tailLogs: async function* () {},
    };
    store.add(deployment({ id: "d1", status: "Deploying" }));

    await expect(handleReconcileJob({ store, runtime }, { serviceInstanceId: INSTANCE }, budget)).rejects.toThrow(
      /api do cluster fora do ar/,
    );
    expect(store.get("d1")!.status).toBe("Deploying");
  });

  it("erro transitório na última tentativa falha o deployment com o motivo", async () => {
    const store = new InMemoryDeploymentStore();
    const runtime = {
      applyWorkload: async () => {
        throw new Error("api do cluster fora do ar");
      },
      getStatus: async () => null,
      tailLogs: async function* () {},
    };
    store.add(deployment({ id: "d1", status: "Deploying" }));

    const result = await handleReconcileJob({ store, runtime }, { serviceInstanceId: INSTANCE }, lastAttempt);

    expect(result).toEqual({ kind: "failed", deploymentId: "d1" });
    expect(store.get("d1")!.status).toBe("Failed");
    expect(store.events.at(-1)!.reason).toMatch(/erro após 3 tentativas: api do cluster fora do ar/);
  });
});

describe("deployment recém-criado (Queued) com imagem por digest", () => {
  it("passa por Building e Deploying, sem build, e segue o caminho normal", async () => {
    const { deps, store, runtime } = setup();
    store.add(deployment({ id: "d1", status: "Queued" }));

    const first = await reconcileInstance(deps, INSTANCE);
    expect(first).toEqual({ kind: "pending", deploymentId: "d1", reason: expect.any(String), phase: "HealthChecking" });
    expect(store.events.map((e) => [e.from, e.to])).toEqual([
      ["Queued", "Building"],
      ["Building", "Deploying"],
      ["Deploying", "HealthChecking"],
    ]);
    expect(store.events[0].reason).toMatch(/build dispensado/);

    runtime.markReady(workloadName(INSTANCE));
    expect(await reconcileInstance(deps, INSTANCE)).toEqual({ kind: "converged", deploymentId: "d1" });
    expect(store.get("d1")!.status).toBe("Running");
  });
});

describe("deployment de repositório: estágio de build", () => {
  const SHA = "c6ba3ae5b6c700cc04950ff8389d8a37f31e5913";
  const REPO = { commitSha: SHA, repoUrl: "http://host.k3d.internal:8189/app.git", imageDigest: null };
  const BUILT = "k3d-railway-reg:5000/workloads/inst-1@sha256:" + "c".repeat(64);

  it("build em andamento mantém o deployment em Building e fica pendente na fase Building", async () => {
    const { deps, store, builder } = setup();
    store.add(deployment({ id: "d1", status: "Queued", ...REPO }));

    const result = await reconcileInstance(deps, INSTANCE);

    expect(result).toEqual({ kind: "pending", deploymentId: "d1", reason: "build em andamento", phase: "Building" });
    expect(store.get("d1")!.status).toBe("Building");
    expect(store.get("d1")!.imageDigest).toBeNull();
    expect(await builder.status({ deploymentId: "d1", serviceInstanceId: INSTANCE })).toEqual({ kind: "running" });
  });

  it("build concluído grava o digest, segue para Deploying e converge depois do health check", async () => {
    const { deps, store, runtime, builder } = setup();
    store.add(deployment({ id: "d1", status: "Queued", ...REPO }));
    await reconcileInstance(deps, INSTANCE);
    builder.finish("d1", { kind: "succeeded", imageDigest: BUILT });

    const built = await reconcileInstance(deps, INSTANCE);
    expect(built).toEqual({ kind: "pending", deploymentId: "d1", reason: expect.any(String), phase: "HealthChecking" });
    expect(store.get("d1")!.imageDigest).toBe(BUILT);
    expect(store.events.map((e) => e.to)).toEqual(["Building", "Deploying", "HealthChecking"]);

    runtime.markReady(workloadName(INSTANCE));
    expect(await reconcileInstance(deps, INSTANCE)).toEqual({ kind: "converged", deploymentId: "d1" });
  });

  it("build que falha leva o deployment a Failed na hora, com o motivo", async () => {
    const { deps, store, builder } = setup();
    store.add(deployment({ id: "d1", status: "Queued", ...REPO }));
    await reconcileInstance(deps, INSTANCE);
    builder.finish("d1", { kind: "failed", reason: "build falhou (código 1)" });

    const result = await handleReconcileJob(deps, { serviceInstanceId: INSTANCE }, { attemptsMade: 0, maxAttempts: 3 });

    expect(result).toEqual({ kind: "failed", deploymentId: "d1" });
    expect(store.get("d1")!.status).toBe("Failed");
    expect(store.events.at(-1)!.reason).toBe("build falhou: build falhou (código 1)");
  });

  it("sem builder configurado, deployment de repositório falha de forma permanente", async () => {
    const store = new InMemoryDeploymentStore();
    const runtime = new InMemoryRuntime();
    store.add(deployment({ id: "d1", status: "Queued", ...REPO }));

    const result = await handleReconcileJob({ store, runtime }, { serviceInstanceId: INSTANCE }, { attemptsMade: 0, maxAttempts: 3 });

    expect(result).toEqual({ kind: "failed", deploymentId: "d1" });
    expect(store.events.at(-1)!.reason).toMatch(/builder não configurado/);
  });

  it("esgotar o orçamento durante o build diz que o build não concluiu", async () => {
    const { deps, store } = setup();
    store.add(deployment({ id: "d1", status: "Queued", ...REPO }));
    await reconcileInstance(deps, INSTANCE);

    const result = await handleReconcileJob(deps, { serviceInstanceId: INSTANCE }, { attemptsMade: 239, maxAttempts: 240 });

    expect(result).toEqual({ kind: "failed", deploymentId: "d1" });
    expect(store.events.at(-1)!.reason).toMatch(/build não concluiu após 240 tentativas/);
  });

  it("um digest já gravado não é sobrescrito", async () => {
    const store = new InMemoryDeploymentStore();
    store.add(deployment({ id: "d1", status: "Building", imageDigest: BUILT }));
    expect(await store.setImageDigest("d1", "outro@sha256:" + "d".repeat(64))).toBe(false);
    expect(store.get("d1")!.imageDigest).toBe(BUILT);
  });
});

describe("logs do build", () => {
  const SHA = "c6ba3ae5b6c700cc04950ff8389d8a37f31e5913";
  const REPO = { commitSha: SHA, repoUrl: "http://host.k3d.internal:8189/app.git", imageDigest: null };

  it("cada leitura do build grava o último retrato dos logs", async () => {
    const { deps, store, builder } = setup();
    store.add(deployment({ id: "d1", status: "Queued", ...REPO }));
    builder.setLogs("d1", "=== build ===\nfase 1");

    await reconcileInstance(deps, INSTANCE);

    expect(store.buildLogs.get("d1")).toBe("=== build ===\nfase 1");
  });

  it("falha ao ler logs não muda o resultado do build", async () => {
    const { deps, store, builder } = setup();
    store.add(deployment({ id: "d1", status: "Queued", ...REPO }));
    builder.logs = async () => {
      throw new Error("API de logs indisponível");
    };

    const result = await reconcileInstance(deps, INSTANCE);

    expect(result).toEqual({ kind: "pending", deploymentId: "d1", reason: "build em andamento", phase: "Building" });
    expect(store.get("d1")!.status).toBe("Building");
  });
});
