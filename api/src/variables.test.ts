import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { db } from "./db/client.js";
import { createUserWithToken } from "./db/fixtures.js";
import { memberships, variables } from "./db/schema.js";
import { testKeyring } from "./crypto/testing.js";

const app = buildApp(db, { keyring: testKeyring() });

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

async function setup() {
  const { token, org } = await createUserWithToken(db);
  const project = (
    await app.inject({ method: "POST", url: "/v1/projects", headers: auth(token), payload: { organizationId: org.id, name: "Web" } })
  ).json();
  await app.inject({
    method: "POST",
    url: `/v1/projects/${project.id}/services`,
    headers: auth(token),
    payload: { name: "api", kind: "web", source: "github_repo", repoUrl: "https://github.com/acme/api.git" },
  });
  const list = (
    await app.inject({ method: "GET", url: `/v1/projects/${project.id}/services`, headers: auth(token) })
  ).json().data as { instances: { id: string }[] }[];
  return { token, orgId: org.id as string, instanceId: list[0].instances[0].id as string };
}

describe("variables", () => {
  it("creates and reads a non-secret variable in plain text", async () => {
    const { token, instanceId } = await setup();
    const put = await app.inject({
      method: "PUT",
      url: `/v1/services/${instanceId}/variables/LOG_LEVEL`,
      headers: auth(token),
      payload: { value: "debug" },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().version).toBe(1);

    const list = await app.inject({ method: "GET", url: `/v1/services/${instanceId}/variables`, headers: auth(token) });
    expect(list.json().data).toEqual([expect.objectContaining({ key: "LOG_LEVEL", value: "debug", isSecret: false })]);
  });

  it("never returns a secret's value and only stores the ciphertext", async () => {
    const { token, instanceId } = await setup();
    await app.inject({
      method: "PUT",
      url: `/v1/services/${instanceId}/variables/DATABASE_URL`,
      headers: auth(token),
      payload: { value: "postgres://user:real-password@host/db", isSecret: true },
    });

    const list = await app.inject({ method: "GET", url: `/v1/services/${instanceId}/variables`, headers: auth(token) });
    expect(list.json().data[0]).toEqual(expect.objectContaining({ key: "DATABASE_URL", value: null, isSecret: true }));
    expect(JSON.stringify(list.json())).not.toContain("real-password");

    const [row] = await db.select().from(variables);
    expect(row.valueEnc).not.toContain("real-password");
    expect(row.valueEnc.startsWith("v1.")).toBe(true);
  });

  it("updating increments the version and replaces the value", async () => {
    const { token, instanceId } = await setup();
    const url = `/v1/services/${instanceId}/variables/PORT`;
    await app.inject({ method: "PUT", url, headers: auth(token), payload: { value: "3000" } });
    const second = await app.inject({ method: "PUT", url, headers: auth(token), payload: { value: "8080" } });
    expect(second.json().version).toBe(2);

    const list = await app.inject({ method: "GET", url: `/v1/services/${instanceId}/variables`, headers: auth(token) });
    expect(list.json().data).toHaveLength(1);
    expect(list.json().data[0].value).toBe("8080");
  });

  it("removes a variable and returns 404 when it doesn't exist", async () => {
    const { token, instanceId } = await setup();
    const url = `/v1/services/${instanceId}/variables/PORT`;
    await app.inject({ method: "PUT", url, headers: auth(token), payload: { value: "3000" } });

    expect((await app.inject({ method: "DELETE", url, headers: auth(token) })).statusCode).toBe(204);
    const again = await app.inject({ method: "DELETE", url, headers: auth(token) });
    expect(again.statusCode).toBe(404);
    expect(again.json().code).toBe("variable_not_found");
  });

  it("rejects an invalid variable name", async () => {
    const { token, instanceId } = await setup();
    const res = await app.inject({
      method: "PUT",
      url: `/v1/services/${instanceId}/variables/lowercase-with-hyphen`,
      headers: auth(token),
      payload: { value: "x" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("validation_failed");
  });

  it("prevents a viewer from changing variables, but allows listing", async () => {
    const { token, orgId, instanceId } = await setup();
    await app.inject({
      method: "PUT",
      url: `/v1/services/${instanceId}/variables/PORT`,
      headers: auth(token),
      payload: { value: "3000" },
    });
    const viewer = await createUserWithToken(db, "viewer");
    await db.insert(memberships).values({ organizationId: orgId, userId: viewer.user.id, role: "viewer" });

    const put = await app.inject({
      method: "PUT",
      url: `/v1/services/${instanceId}/variables/PORT`,
      headers: auth(viewer.token),
      payload: { value: "1" },
    });
    expect(put.statusCode).toBe(403);

    const list = await app.inject({ method: "GET", url: `/v1/services/${instanceId}/variables`, headers: auth(viewer.token) });
    expect(list.statusCode).toBe(200);
  });

  it("returns 404 for an instance in another organization", async () => {
    const { instanceId } = await setup();
    const outsider = await createUserWithToken(db, "outsider");
    const res = await app.inject({ method: "GET", url: `/v1/services/${instanceId}/variables`, headers: auth(outsider.token) });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("instance_not_found");
  });

  it("does not store the value in the audit log", async () => {
    const { token, instanceId } = await setup();
    await app.inject({
      method: "PUT",
      url: `/v1/services/${instanceId}/variables/API_KEY`,
      headers: auth(token),
      payload: { value: "very-secret-key", isSecret: true },
    });
    const { rows } = await db.execute<{ metadata: unknown; target: string }>(
      sql`select target, metadata from audit_logs where action = 'variable.upsert'`,
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain("very-secret-key");
  });
});
