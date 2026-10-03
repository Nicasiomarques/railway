import { Queue, QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { namespaceFor, workloadName } from "../runtime/adapter.js";
import { InMemoryRuntime } from "../runtime/in-memory.js";
import { InMemoryDeploymentStore } from "./in-memory-store.js";
import { DEPLOYMENTS_QUEUE, RECONCILE_JOB, createReconcileWorker, enqueueReconcile, type ReconcileJobData } from "./worker.js";
import { CANCEL_BUILD_JOB, type CancelBuildJobData } from "@railway-like/shared";
import { InMemoryBuilder } from "../build/in-memory-builder.js";

const REDIS_URL = process.env.REDIS_URL;
const INSTANCE = "inst-int";
const IMAGE = "registry.local/app@sha256:ccc";

// Roda só com Redis disponível: REDIS_URL=redis://localhost:6379 pnpm test
describe.skipIf(!REDIS_URL)("reconciliador com BullMQ e Redis reais", () => {
  let connection: Redis;
  let queue: Queue<ReconcileJobData>;

  beforeAll(async () => {
    connection = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
    queue = new Queue<ReconcileJobData>(DEPLOYMENTS_QUEUE, { connection });
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue.close();
    await connection.quit();
  });

  const deployment = (store: InMemoryDeploymentStore) =>
    store.add({
      id: "d-int",
      serviceInstanceId: INSTANCE,
      environmentId: "env-int",
      versionNo: 1,
      status: "Deploying",
      imageDigest: IMAGE,
      env: { PORT: "3000" },
      replicas: 1,
    });

  it("dedupe: enfileirar a mesma versão duas vezes deixa um job só", async () => {
    await enqueueReconcile(queue, { serviceInstanceId: INSTANCE, versionNo: 1 });
    await enqueueReconcile(queue, { serviceInstanceId: INSTANCE, versionNo: 1 });
    expect(await queue.getWaitingCount()).toBe(1);
  });

  it("versão nova não fica presa atrás de um job ativo de outra versão", async () => {
    await enqueueReconcile(queue, { serviceInstanceId: INSTANCE, versionNo: 1 });
    await enqueueReconcile(queue, { serviceInstanceId: INSTANCE, versionNo: 2 });
    expect(await queue.getWaitingCount()).toBe(2);
  });

  it("caminho feliz: réplicas prontas levam o deployment a Running no primeiro job", async () => {
    const store = new InMemoryDeploymentStore();
    const runtime = new InMemoryRuntime();
    deployment(store);
    // Workload já aplicado com a mesma spec e pronto: o reconciliador só precisa promover.
    await runtime.applyWorkload({ name: workloadName(INSTANCE), namespace: namespaceFor("env-int"), image: IMAGE, env: { PORT: "3000" }, replicas: 1 });
    runtime.markReady(workloadName(INSTANCE));

    const worker = createReconcileWorker(connection, { store, runtime });
    const events = new QueueEvents(DEPLOYMENTS_QUEUE, { connection });
    await events.waitUntilReady();
    const job = await queue.add(RECONCILE_JOB, { serviceInstanceId: INSTANCE }, { attempts: 3, backoff: { type: "fixed", delay: 50 } });

    await job.waitUntilFinished(events, 10_000);
    await worker.close();
    await events.close();

    expect(store.get("d-int")!.status).toBe("Running");
  }, 20_000);

  it("retries esgotados: sem health check, o deployment vai para Failed com o motivo", async () => {
    const store = new InMemoryDeploymentStore();
    const runtime = new InMemoryRuntime();
    deployment(store);

    const worker = createReconcileWorker(connection, { store, runtime });
    const events = new QueueEvents(DEPLOYMENTS_QUEUE, { connection });
    await events.waitUntilReady();
    const job = await queue.add(RECONCILE_JOB, { serviceInstanceId: INSTANCE }, { attempts: 2, backoff: { type: "fixed", delay: 50 } });

    const result = await job.waitUntilFinished(events, 10_000);
    await worker.close();
    await events.close();

    expect(result).toEqual({ kind: "failed", deploymentId: "d-int" });
    expect(store.get("d-int")!.status).toBe("Failed");
    expect(store.events.at(-1)!.reason).toMatch(/após 2 tentativas/);
  }, 20_000);
});

describe.skipIf(!REDIS_URL)("job de cancelamento de build na mesma fila", () => {
  it("o worker apaga o build do deployment cancelado", async () => {
    const connection = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
    const queue = new Queue<ReconcileJobData | CancelBuildJobData>(DEPLOYMENTS_QUEUE, { connection });
    await queue.obliterate({ force: true });
    const builder = new InMemoryBuilder();
    await builder.start({ deploymentId: "d-cancel", serviceInstanceId: INSTANCE, repoUrl: "https://x/y.git", commitSha: "a".repeat(40), rootDir: "/" });
    const worker = createReconcileWorker(connection, { store: new InMemoryDeploymentStore(), runtime: new InMemoryRuntime(), builder });
    const events = new QueueEvents(DEPLOYMENTS_QUEUE, { connection });
    await events.waitUntilReady();

    const job = await queue.add(CANCEL_BUILD_JOB, { deploymentId: "d-cancel", serviceInstanceId: INSTANCE });
    const result = await job.waitUntilFinished(events, 10_000);
    await worker.close();
    await events.close();

    expect(result).toEqual({ kind: "cancelled" });
    expect(await builder.status({ deploymentId: "d-cancel", serviceInstanceId: INSTANCE })).toEqual({ kind: "failed", reason: "build cancelado" });
    await queue.obliterate({ force: true });
    await queue.close();
    await connection.quit();
  }, 20_000);
});
