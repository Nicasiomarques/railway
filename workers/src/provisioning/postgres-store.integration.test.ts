import { environments, createDb, organizations, projects } from "@railway-like/db";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { InMemoryRuntime } from "../runtime/in-memory.js";
import { resetDb } from "../test/fixtures.js";
import { PostgresEnvironmentStore } from "./postgres-store.js";
import { provisionEnvironment } from "./saga.js";

// Runs only with WORKERS_TEST_DATABASE_URL. Truncates tables: don't run alongside the API suite.
const DATABASE_URL = process.env.WORKERS_TEST_DATABASE_URL;

describe.skipIf(!DATABASE_URL)("PostgresEnvironmentStore", () => {
  const { db, pool } = createDb(DATABASE_URL!);
  const store = new PostgresEnvironmentStore(db);

  afterAll(async () => {
    await (pool as Pool).end();
  });

  beforeEach(async () => {
    await resetDb(db);
  });

  async function seedEnvironment(): Promise<{ envId: string; projectId: string }> {
    const [org] = await db.insert(organizations).values({ name: "Acme", slug: "acme" }).returning();
    const [project] = await db.insert(projects).values({ organizationId: org.id, name: "Web", slug: "web" }).returning();
    const [env] = await db
      .insert(environments)
      .values({ projectId: project.id, name: "production", type: "production" })
      .returning();
    return { envId: env.id, projectId: project.id };
  }

  it("a new environment starts pending, with no steps", async () => {
    const { envId, projectId } = await seedEnvironment();

    expect(await store.findEnvironment(envId)).toEqual({
      id: envId,
      projectId,
      status: "pending",
      completedSteps: [],
    });
  });

  it("a nonexistent environment returns null", async () => {
    expect(await store.findEnvironment("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("a completed saga records ready and the three steps in order", async () => {
    const { envId } = await seedEnvironment();

    const result = await provisionEnvironment({ store, runtime: new InMemoryRuntime() }, { environmentId: envId });

    expect(result).toEqual({ kind: "ready", environmentId: envId });
    const [row] = await db.select().from(environments).where(eq(environments.id, envId));
    expect(row).toMatchObject({
      provisioningStatus: "ready",
      provisioningSteps: ["namespace", "default-deny-policy", "quota"],
      provisioningError: null,
    });
  });

  it("markStepDone doesn't duplicate a step that's already recorded", async () => {
    const { envId } = await seedEnvironment();

    await store.markStepDone(envId, "namespace");
    await store.markStepDone(envId, "namespace");

    expect((await store.findEnvironment(envId))?.completedSteps).toEqual(["namespace"]);
  });

  it("markFailed records the reason and the failed status", async () => {
    const { envId } = await seedEnvironment();

    await store.markFailed(envId, "error after 10 attempts: no cluster");

    const [row] = await db.select().from(environments).where(eq(environments.id, envId));
    expect(row).toMatchObject({ provisioningStatus: "failed", provisioningError: "error after 10 attempts: no cluster" });
  });
});
