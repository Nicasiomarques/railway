import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { testKeyring } from "./crypto/testing.js";
import { db } from "./db/client.js";
import { createUserWithToken } from "./db/fixtures.js";
import { memberships } from "./db/schema.js";

const app = buildApp(db, { keyring: testKeyring() });

beforeEach(async () => {
  const { rows } = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public' and tablename <> '__drizzle_migrations'`,
  );
  await db.execute(sql.raw(`truncate ${rows.map((r) => `"${r.tablename}"`).join(", ")} restart identity cascade`));
});

afterAll(async () => {
  await app.close();
});

const auth = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });

async function setupProject() {
  const { token, org } = await createUserWithToken(db);
  const res = await app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: auth(token),
    payload: { organizationId: org.id, name: "Web" },
  });
  return { token, orgId: org.id, projectId: res.json().id as string };
}

describe("templates", () => {
  it("lists the marketplace catalog without needing a project", async () => {
    const { token } = await setupProject();
    const res = await app.inject({ method: "GET", url: "/v1/templates", headers: auth(token) });
    expect(res.statusCode).toBe(200);
    const sources = res.json().data.map((t: { source: string }) => t.source).sort();
    expect(sources).toEqual(["minio_template", "postgres_template", "redis_template"]);
  });

  it("deploys a template as a preconfigured service with a default name", async () => {
    const { token, projectId } = await setupProject();
    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/templates/postgres_template/deploy`,
      headers: auth(token),
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe("postgresql");
    expect(res.json().kind).toBe("postgres");
    expect(res.json().source).toBe("postgres_template");
    expect(res.json().instances).toHaveLength(1);
  });

  it("deploys a template under a caller-chosen name", async () => {
    const { token, projectId } = await setupProject();
    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/templates/redis_template/deploy`,
      headers: auth(token),
      payload: { name: "cache" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe("cache");
    expect(res.json().kind).toBe("redis");
  });

  it("returns 404 for an unknown template", async () => {
    const { token, projectId } = await setupProject();
    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/templates/not-a-template/deploy`,
      headers: auth(token),
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("template_not_found");
  });

  it("returns 409 when the resolved name collides with an existing service", async () => {
    const { token, projectId } = await setupProject();
    await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/services`,
      headers: auth(token),
      payload: { name: "postgresql", kind: "postgres", source: "image" },
    });
    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/templates/postgres_template/deploy`,
      headers: auth(token),
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("name_taken");
  });

  it("prevents a viewer from deploying a template", async () => {
    const { projectId, orgId } = await setupProject();
    const viewer = await createUserWithToken(db, "viewer");
    await db.insert(memberships).values({ organizationId: orgId, userId: viewer.user.id, role: "viewer" });

    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/templates/postgres_template/deploy`,
      headers: auth(viewer.token),
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("forbidden");
  });

  it("returns 404 for a project in another organization", async () => {
    const { projectId } = await setupProject();
    const outsider = await createUserWithToken(db, "outsider");
    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/templates/postgres_template/deploy`,
      headers: auth(outsider.token),
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("project_not_found");
  });

  it("repeating with the same Idempotency-Key does not deploy the template twice", async () => {
    const { token, projectId } = await setupProject();
    const headers = auth(token, { "idempotency-key": "tpl-1" });
    const a = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/templates/postgres_template/deploy`,
      headers,
      payload: {},
    });
    const b = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/templates/postgres_template/deploy`,
      headers,
      payload: {},
    });
    expect(b.json().id).toBe(a.json().id);

    const list = await app.inject({ method: "GET", url: `/v1/projects/${projectId}/services`, headers: auth(token) });
    expect(list.json().data).toHaveLength(1);
  });
});
