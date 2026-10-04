import { createDb, domains, environments, serviceInstances } from "@railway-like/db";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, seedInstance } from "../test/fixtures.js";
import { PostgresDecommissionStore } from "./postgres-store.js";

// Runs only with WORKERS_TEST_DATABASE_URL. Truncates tables: don't run alongside the API suite.
const DATABASE_URL = process.env.WORKERS_TEST_DATABASE_URL;

describe.skipIf(!DATABASE_URL)("PostgresDecommissionStore", () => {
  const { db, pool } = createDb(DATABASE_URL!);
  const store = new PostgresDecommissionStore(db);

  afterAll(async () => {
    await (pool as Pool).end();
  });

  beforeEach(async () => {
    await resetDb(db);
  });

  async function envIdFor(instanceId: string): Promise<string> {
    const [instance] = await db.select().from(serviceInstances).where(eq(serviceInstances.id, instanceId));
    return instance.environmentId;
  }

  it("a nonexistent environment returns null", async () => {
    expect(await store.findEnvironment("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("listExpired excludes environments with no ttl_at or a future one", async () => {
    const instanceId = await seedInstance(db);
    const envId = await envIdFor(instanceId);

    expect(await store.listExpired(new Date())).toEqual([]);

    await db.update(environments).set({ ttlAt: new Date(Date.now() + 60_000) }).where(eq(environments.id, envId));
    expect(await store.listExpired(new Date())).toEqual([]);
  });

  it("listExpired finds an environment whose ttl_at has passed, and not a soft-deleted one", async () => {
    const instanceId = await seedInstance(db);
    const envId = await envIdFor(instanceId);
    await db.update(environments).set({ ttlAt: new Date(Date.now() - 1000) }).where(eq(environments.id, envId));

    expect(await store.listExpired(new Date())).toMatchObject([{ id: envId }]);

    await db.update(environments).set({ deletedAt: new Date() }).where(eq(environments.id, envId));
    expect(await store.listExpired(new Date())).toEqual([]);
  });

  it("listServiceInstanceIds excludes an already soft-deleted instance", async () => {
    const instanceId = await seedInstance(db);
    const envId = await envIdFor(instanceId);

    expect(await store.listServiceInstanceIds(envId)).toEqual([instanceId]);

    await store.markServiceInstanceDeleted(instanceId);
    expect(await store.listServiceInstanceIds(envId)).toEqual([]);
  });

  it("deleteDomains removes every domain row for the instance", async () => {
    const instanceId = await seedInstance(db);
    await db.insert(domains).values({ serviceInstanceId: instanceId, hostname: "app-aaa.apps.railway.local", type: "auto" });

    await store.deleteDomains(instanceId);

    expect(await db.select().from(domains).where(eq(domains.serviceInstanceId, instanceId))).toEqual([]);
  });

  it("markEnvironmentDeleted sets deleted_at", async () => {
    const instanceId = await seedInstance(db);
    const envId = await envIdFor(instanceId);

    await store.markEnvironmentDeleted(envId);

    const [row] = await db.select().from(environments).where(eq(environments.id, envId));
    expect(row.deletedAt).toBeInstanceOf(Date);
  });
});
