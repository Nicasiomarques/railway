import { environments, createDb, organizations, projects } from "@railway-like/db";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { InMemoryRuntime } from "../runtime/in-memory.js";
import { resetDb } from "../test/fixtures.js";
import { PostgresEnvironmentStore } from "./postgres-store.js";
import { provisionEnvironment } from "./saga.js";

// Roda só com WORKERS_TEST_DATABASE_URL. Trunca tabelas: não rode junto com a suíte da API.
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

  it("ambiente novo começa pending, sem passos", async () => {
    const { envId, projectId } = await seedEnvironment();

    expect(await store.findEnvironment(envId)).toEqual({
      id: envId,
      projectId,
      status: "pending",
      completedSteps: [],
    });
  });

  it("ambiente inexistente devolve null", async () => {
    expect(await store.findEnvironment("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("saga completa grava ready e os três passos em ordem", async () => {
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

  it("markStepDone não duplica um passo já registrado", async () => {
    const { envId } = await seedEnvironment();

    await store.markStepDone(envId, "namespace");
    await store.markStepDone(envId, "namespace");

    expect((await store.findEnvironment(envId))?.completedSteps).toEqual(["namespace"]);
  });

  it("markFailed grava o motivo e o status failed", async () => {
    const { envId } = await seedEnvironment();

    await store.markFailed(envId, "erro após 10 tentativas: sem cluster");

    const [row] = await db.select().from(environments).where(eq(environments.id, envId));
    expect(row).toMatchObject({ provisioningStatus: "failed", provisioningError: "erro após 10 tentativas: sem cluster" });
  });
});
