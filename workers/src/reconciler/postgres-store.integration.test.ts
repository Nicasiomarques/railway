import { createDb, deploymentEvents, deployments } from "@railway-like/db";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { workloadName } from "../runtime/adapter.js";
import { InMemoryRuntime } from "../runtime/in-memory.js";
import { addDeployment, resetDb, seedInstance } from "../test/fixtures.js";
import { handleReconcileJob, reconcileInstance } from "./reconcile.js";
import { PostgresDeploymentStore } from "./postgres-store.js";

// Roda só com WORKERS_TEST_DATABASE_URL. Trunca tabelas: não rode junto com a suíte da API.
const DATABASE_URL = process.env.WORKERS_TEST_DATABASE_URL;

describe.skipIf(!DATABASE_URL)("PostgresDeploymentStore", () => {
  const { db, pool } = createDb(DATABASE_URL!);
  const store = new PostgresDeploymentStore(db, async () => ({ PORT: "3000" }));

  afterAll(async () => {
    await (pool as Pool).end();
  });

  beforeEach(async () => {
    await resetDb(db);
  });

  it("findActive devolve o deployment ativo mais recente, com réplicas e env", async () => {
    const instanceId = await seedInstance(db, 3);
    await addDeployment(db, instanceId, 1, "Running");
    const newest = await addDeployment(db, instanceId, 2, "Deploying");

    const found = await store.findActive(instanceId);

    expect(found).toMatchObject({ id: newest, versionNo: 2, status: "Deploying", replicas: 3, env: { PORT: "3000" } });
  });

  it("findActive devolve null quando só há Running", async () => {
    const instanceId = await seedInstance(db);
    await addDeployment(db, instanceId, 1, "Running");
    expect(await store.findActive(instanceId)).toBeNull();
  });

  it("deployment sem image_digest é falha permanente: vai para Failed no banco, sem retries", async () => {
    const instanceId = await seedInstance(db);
    const id = await addDeployment(db, instanceId, 1, "Deploying", null);

    const result = await handleReconcileJob({ store, runtime: new InMemoryRuntime() }, { serviceInstanceId: instanceId }, { attemptsMade: 0, maxAttempts: 3 });

    expect(result).toEqual({ kind: "failed", deploymentId: id });
    const [row] = await db.select({ status: deployments.status }).from(deployments).where(eq(deployments.id, id));
    expect(row.status).toBe("Failed");
  });

  it("setStatus é compare-and-set e grava o evento na mesma transação", async () => {
    const instanceId = await seedInstance(db);
    const id = await addDeployment(db, instanceId, 1, "Deploying");

    expect(await store.setStatus(id, "Running", "Failed")).toBe(false);
    expect(await store.setStatus(id, "Deploying", "HealthChecking", "início do health check")).toBe(true);

    const events = await db.select().from(deploymentEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fromStatus: "Deploying", toStatus: "HealthChecking", reason: "início do health check" });
  });

  it("promote troca o Running anterior por Superseded e promove o novo, com eventos", async () => {
    const instanceId = await seedInstance(db);
    const previous = await addDeployment(db, instanceId, 1, "Running");
    const next = await addDeployment(db, instanceId, 2, "HealthChecking");

    expect(await store.promote(next)).toBe(true);

    const rows = await db.select({ id: deployments.id, status: deployments.status }).from(deployments);
    expect(rows.find((r) => r.id === previous)!.status).toBe("Superseded");
    expect(rows.find((r) => r.id === next)!.status).toBe("Running");
    const events = await db.select().from(deploymentEvents);
    expect(events.map((e) => e.toStatus).sort()).toEqual(["Running", "Superseded"]);
  });

  it("promote recusa deployment que não está em HealthChecking", async () => {
    const instanceId = await seedInstance(db);
    const id = await addDeployment(db, instanceId, 1, "Deploying");
    expect(await store.promote(id)).toBe(false);
  });

  it("reconcileInstance ponta a ponta sobre Postgres: Deploying → Running com rollout", async () => {
    const instanceId = await seedInstance(db, 1);
    const previous = await addDeployment(db, instanceId, 1, "Running");
    const next = await addDeployment(db, instanceId, 2, "Deploying", "registry.local/app@sha256:bbb");
    const runtime = new InMemoryRuntime();

    const pending = await reconcileInstance({ store, runtime }, instanceId);
    expect(pending.kind).toBe("pending");
    runtime.markReady(workloadName(instanceId));
    const done = await reconcileInstance({ store, runtime }, instanceId);

    expect(done).toEqual({ kind: "converged", deploymentId: next });
    const rows = await db.select({ id: deployments.id, status: deployments.status }).from(deployments);
    expect(rows.find((r) => r.id === previous)!.status).toBe("Superseded");
    expect(rows.find((r) => r.id === next)!.status).toBe("Running");
  });
});
