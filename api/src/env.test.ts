import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { db } from "./db/client.js";
import { createUserWithToken } from "./db/fixtures.js";
import { testKeyring } from "./crypto/testing.js";
import { resolveInstanceEnv } from "./env/resolve.js";

const keyring = testKeyring();
const app = buildApp(db, { keyring });

beforeEach(async () => {
  const { rows } = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public' and tablename not in ('__drizzle_migrations', 'regions')`,
  );
  await db.execute(sql.raw(`truncate ${rows.map((r) => `"${r.tablename}"`).join(", ")} restart identity cascade`));
});

afterAll(async () => {
  await app.close();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

// Creates a project with `api` and `postgres` services; returns the instance ids.
async function setup() {
  const { token, org } = await createUserWithToken(db);
  const project = (
    await app.inject({ method: "POST", url: "/v1/projects", headers: auth(token), payload: { organizationId: org.id, name: "Web" } })
  ).json();
  for (const [name, kind] of [["api", "web"], ["postgres", "postgres"]]) {
    await app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/services`,
      headers: auth(token),
      payload: { name, kind, source: "template" },
    });
  }
  const list = (
    await app.inject({ method: "GET", url: `/v1/projects/${project.id}/services`, headers: auth(token) })
  ).json().data as { name: string; instances: { id: string }[] }[];
  const instanceOf = (name: string) => list.find((s) => s.name === name)!.instances[0].id;
  return { token, orgId: org.id as string, projectId: project.id as string, api: instanceOf("api"), pg: instanceOf("postgres") };
}

const put = (token: string, instanceId: string, key: string, value: string, isSecret = false) =>
  app.inject({
    method: "PUT",
    url: `/v1/services/${instanceId}/variables/${key}`,
    headers: auth(token),
    payload: { value, isSecret },
  });

const connect = (token: string, projectId: string, from: string, to: string) =>
  app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/connections`,
    headers: auth(token),
    payload: { fromInstanceId: from, toInstanceId: to },
  });

describe("references between services", () => {
  it("api reads DATABASE_URL from postgres via the connection and the result becomes a secret", async () => {
    const { token, projectId, api, pg } = await setup();
    await put(token, pg, "DATABASE_URL", "postgres://u:password@pg:5432/app", true);
    await put(token, api, "DATABASE_URL", "${{postgres.DATABASE_URL}}");
    await connect(token, projectId, api, pg);

    const env = await resolveInstanceEnv(db, keyring, api);
    expect(env).toEqual([{ key: "DATABASE_URL", value: "postgres://u:password@pg:5432/app", isSecret: true }]);
  });

  it("without a connection, the reference does not resolve", async () => {
    const { token, api, pg } = await setup();
    await put(token, pg, "DATABASE_URL", "postgres://x");
    await put(token, api, "DATABASE_URL", "${{postgres.DATABASE_URL}}");

    await expect(resolveInstanceEnv(db, keyring, api)).rejects.toMatchObject({ code: "unresolved_reference" });
  });

  it("the connection is directional: postgres cannot see api's variables", async () => {
    const { token, projectId, api, pg } = await setup();
    await put(token, api, "SECRET_TOKEN", "abc", true);
    await put(token, pg, "DATABASE_URL", "${{api.SECRET_TOKEN}}");
    await connect(token, projectId, api, pg);

    await expect(resolveInstanceEnv(db, keyring, pg)).rejects.toMatchObject({ code: "unresolved_reference" });
  });

  it("fails when the referenced key does not exist on the target", async () => {
    const { token, projectId, api, pg } = await setup();
    await put(token, pg, "OTHER", "x");
    await put(token, api, "DATABASE_URL", "${{postgres.DATABASE_URL}}");
    await connect(token, projectId, api, pg);

    await expect(resolveInstanceEnv(db, keyring, api)).rejects.toMatchObject({ code: "unresolved_reference" });
  });

  it("rejects chained references", async () => {
    const { token, projectId, api, pg } = await setup();
    await put(token, pg, "DATABASE_URL", "${{api.X}}");
    await put(token, api, "DATABASE_URL", "${{postgres.DATABASE_URL}}");
    await connect(token, projectId, api, pg);

    await expect(resolveInstanceEnv(db, keyring, api)).rejects.toMatchObject({ code: "reference_not_chained" });
  });

  it("values without a reference pass through unchanged", async () => {
    const { token, api } = await setup();
    await put(token, api, "PORT", "3000");
    expect(await resolveInstanceEnv(db, keyring, api)).toEqual([{ key: "PORT", value: "3000", isSecret: false }]);
  });

  it("rejects a malformed reference already at PUT time", async () => {
    const { token, api } = await setup();
    const res = await put(token, api, "DATABASE_URL", "${{postgres}}");
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("invalid_reference");
  });

  it("GET /env returns the resolved environment with secrets masked", async () => {
    const { token, projectId, api, pg } = await setup();
    await put(token, pg, "DATABASE_URL", "postgres://u:password@pg/app", true);
    await put(token, api, "DATABASE_URL", "${{postgres.DATABASE_URL}}");
    await put(token, api, "PORT", "3000");
    await connect(token, projectId, api, pg);

    const res = await app.inject({ method: "GET", url: `/v1/services/${api}/env`, headers: auth(token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual(
      expect.arrayContaining([
        { key: "DATABASE_URL", isSecret: true, value: null },
        { key: "PORT", isSecret: false, value: "3000" },
      ]),
    );
    expect(JSON.stringify(res.json())).not.toContain("password");
  });
});
