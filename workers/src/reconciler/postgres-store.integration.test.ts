import { createDb, deploymentEvents, deployments } from "@railway-like/db";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { workloadName } from "../runtime/adapter.js";
import { InMemoryRuntime } from "../runtime/in-memory.js";
import { SingleRegionRuntimeRegistry } from "../runtime/registry.js";
import { addDeployment, resetDb, seedInstance } from "../test/fixtures.js";
import { handleReconcileJob, reconcileInstance } from "./reconcile.js";
import { PostgresDeploymentStore } from "./postgres-store.js";

// Runs only with WORKERS_TEST_DATABASE_URL. Truncates tables: don't run alongside the API suite.
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

  it("findActive returns the most recent active deployment, with replicas and env", async () => {
    const instanceId = await seedInstance(db, 3);
    await addDeployment(db, instanceId, 1, "Running");
    const newest = await addDeployment(db, instanceId, 2, "Deploying");

    const found = await store.findActive(instanceId);

    expect(found).toMatchObject({ id: newest, versionNo: 2, status: "Deploying", replicas: 3, env: { PORT: "3000" } });
  });

  it("findActive returns null when there's only Running", async () => {
    const instanceId = await seedInstance(db);
    await addDeployment(db, instanceId, 1, "Running");
    expect(await store.findActive(instanceId)).toBeNull();
  });

  it("a deployment with no image_digest is a permanent failure: goes to Failed in the database, with no retries", async () => {
    const instanceId = await seedInstance(db);
    const id = await addDeployment(db, instanceId, 1, "Deploying", null);

    const result = await handleReconcileJob({ store, runtime: new SingleRegionRuntimeRegistry(new InMemoryRuntime()) }, { serviceInstanceId: instanceId }, { attemptsMade: 0, maxAttempts: 3 });

    expect(result).toEqual({ kind: "failed", deploymentId: id });
    const [row] = await db.select({ status: deployments.status }).from(deployments).where(eq(deployments.id, id));
    expect(row.status).toBe("Failed");
  });

  it("setStatus is compare-and-set and writes the event in the same transaction", async () => {
    const instanceId = await seedInstance(db);
    const id = await addDeployment(db, instanceId, 1, "Deploying");

    expect(await store.setStatus(id, "Running", "Failed")).toBe(false);
    expect(await store.setStatus(id, "Deploying", "HealthChecking", "health check started")).toBe(true);

    const events = await db.select().from(deploymentEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fromStatus: "Deploying", toStatus: "HealthChecking", reason: "health check started" });
  });

  it("promote swaps the previous Running for Superseded and promotes the new one, with events", async () => {
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

  it("promote refuses a deployment that isn't in HealthChecking", async () => {
    const instanceId = await seedInstance(db);
    const id = await addDeployment(db, instanceId, 1, "Deploying");
    expect(await store.promote(id)).toBe(false);
  });

  it("reconcileInstance end to end over Postgres: Deploying → Running with rollout", async () => {
    const instanceId = await seedInstance(db, 1);
    const previous = await addDeployment(db, instanceId, 1, "Running");
    const next = await addDeployment(db, instanceId, 2, "Deploying", "registry.local/app@sha256:bbb");
    const runtime = new InMemoryRuntime();

    const registry = new SingleRegionRuntimeRegistry(runtime);
    const pending = await reconcileInstance({ store, runtime: registry }, instanceId);
    expect(pending.kind).toBe("pending");
    runtime.markReady(workloadName(instanceId));
    const done = await reconcileInstance({ store, runtime: registry }, instanceId);

    expect(done).toEqual({ kind: "converged", deploymentId: next });
    const rows = await db.select({ id: deployments.id, status: deployments.status }).from(deployments);
    expect(rows.find((r) => r.id === previous)!.status).toBe("Superseded");
    expect(rows.find((r) => r.id === next)!.status).toBe("Running");
  });
});
