import { eq } from "drizzle-orm";
import { createDb, envSnapshots, sealEnvSnapshot, type Db } from "@railway-like/db";
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, seedInstance } from "../test/fixtures.js";
import { createEnvLoader } from "./env-loader.js";
import { PermanentError } from "./errors.js";

const DATABASE_URL = process.env.WORKERS_TEST_DATABASE_URL;
const keyring = { currentKid: "t", keys: new Map([["t", randomBytes(32)]]) };

describe.skipIf(!DATABASE_URL)("createEnvLoader sobre Postgres", () => {
  const { db, pool } = createDb(DATABASE_URL!);
  const load = createEnvLoader(db as Db, keyring);

  afterAll(async () => {
    await (pool as Pool).end();
  });

  beforeEach(async () => {
    await resetDb(db);
  });

  async function snapshot(env: Record<string, string>): Promise<string> {
    const instanceId = await seedInstance(db);
    const [row] = await db
      .insert(envSnapshots)
      .values({ serviceInstanceId: instanceId, payloadEnc: "pendente" })
      .returning({ id: envSnapshots.id });
    await db.update(envSnapshots).set({ payloadEnc: sealEnvSnapshot(keyring, row.id, env) }).where(eq(envSnapshots.id, row.id));
    return row.id;
  }

  it("decifra o snapshot do deployment", async () => {
    const id = await snapshot({ DATABASE_URL: "postgres://app", PORT: "3000" });
    expect(await load(id)).toEqual({ DATABASE_URL: "postgres://app", PORT: "3000" });
  });

  it("sem snapshot falha alto, como erro permanente", async () => {
    await expect(load(null)).rejects.toBeInstanceOf(PermanentError);
    await expect(load(null)).rejects.toThrow(/sem snapshot/);
  });

  it("snapshot inexistente falha alto", async () => {
    await expect(load("00000000-0000-0000-0000-000000000000")).rejects.toThrow(/não encontrado/);
  });

  it("payload copiado de outro snapshot não decifra (contexto autenticado)", async () => {
    const source = await snapshot({ SECRET: "x" });
    const target = await snapshot({ OTHER: "y" });
    const [src] = await db.select({ payloadEnc: envSnapshots.payloadEnc }).from(envSnapshots).where(eq(envSnapshots.id, source));
    await db.update(envSnapshots).set({ payloadEnc: src.payloadEnc }).where(eq(envSnapshots.id, target));

    await expect(load(target)).rejects.toBeInstanceOf(PermanentError);
    await expect(load(target)).rejects.toThrow(/Falha ao decifrar/);
  });
});
