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

describe("environments", () => {
  it("every project is born with a production environment", async () => {
    const { token, projectId } = await setupProject();
    const res = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/environments`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.map((e: { name: string }) => e.name)).toEqual(["production"]);
  });
});

describe("services", () => {
  it("creates the service with one instance per environment", async () => {
    const { token, projectId } = await setupProject();
    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/services`,
      headers: auth(token),
      payload: { name: "api", kind: "web", source: "github_repo", repoUrl: "https://github.com/acme/api.git" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().rootDir).toBe("/");
    expect(res.json().instances).toHaveLength(1);

    const list = await app.inject({ method: "GET", url: `/v1/projects/${projectId}/services`, headers: auth(token) });
    const [svc] = list.json().data;
    expect(svc.name).toBe("api");
    expect(svc.instances[0].environmentName).toBe("production");
  });

  it("creates instances in every existing environment when the service is created", async () => {
    const { token, projectId } = await setupProject();
    await db.execute(sql`insert into environments (project_id, name, type) values (${projectId}, 'staging', 'staging')`);

    await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/services`,
      headers: auth(token),
      payload: { name: "api", kind: "web", source: "github_repo", repoUrl: "https://github.com/acme/api.git" },
    });
    const list = await app.inject({ method: "GET", url: `/v1/projects/${projectId}/services`, headers: auth(token) });
    const names = list.json().data[0].instances.map((i: { environmentName: string }) => i.environmentName).sort();
    expect(names).toEqual(["production", "staging"]);
  });

  it("returns 409 for a duplicate name in the same project", async () => {
    const { token, projectId } = await setupProject();
    const payload = { name: "api", kind: "web", source: "github_repo", repoUrl: "https://github.com/acme/api.git" };
    await app.inject({ method: "POST", url: `/v1/projects/${projectId}/services`, headers: auth(token), payload });
    const res = await app.inject({ method: "POST", url: `/v1/projects/${projectId}/services`, headers: auth(token), payload });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("name_taken");
  });

  it("rejects an unknown service kind", async () => {
    const { token, projectId } = await setupProject();
    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/services`,
      headers: auth(token),
      payload: { name: "api", kind: "cron", source: "github_repo", repoUrl: "https://github.com/acme/api.git" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("validation_failed");
  });

  it("prevents a viewer from creating a service, but allows reading", async () => {
    const { projectId, orgId } = await setupProject();
    const viewer = await createUserWithToken(db, "viewer");
    await db.insert(memberships).values({ organizationId: orgId, userId: viewer.user.id, role: "viewer" });

    const create = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/services`,
      headers: auth(viewer.token),
      payload: { name: "api", kind: "web", source: "github_repo", repoUrl: "https://github.com/acme/api.git" },
    });
    expect(create.statusCode).toBe(403);
    expect(create.json().code).toBe("forbidden");

    const read = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/services`,
      headers: auth(viewer.token),
    });
    expect(read.statusCode).toBe(200);
  });

  it("returns 404 for a project in another organization", async () => {
    const { projectId } = await setupProject();
    const outsider = await createUserWithToken(db, "outsider");
    const res = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/services`,
      headers: auth(outsider.token),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("project_not_found");
  });

  it("repeating with the same Idempotency-Key does not create another service", async () => {
    const { token, projectId } = await setupProject();
    const headers = auth(token, { "idempotency-key": "svc-1" });
    const payload = { name: "api", kind: "web", source: "github_repo", repoUrl: "https://github.com/acme/api.git" };
    const a = await app.inject({ method: "POST", url: `/v1/projects/${projectId}/services`, headers, payload });
    const b = await app.inject({ method: "POST", url: `/v1/projects/${projectId}/services`, headers, payload });
    expect(b.json().id).toBe(a.json().id);

    const list = await app.inject({ method: "GET", url: `/v1/projects/${projectId}/services`, headers: auth(token) });
    expect(list.json().data).toHaveLength(1);
  });
});
