import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { testKeyring } from "./crypto/testing.js";
import { db } from "./db/client.js";
import { createUserWithToken } from "./db/fixtures.js";
import { memberships } from "./db/schema.js";
import { MAX_ENVIRONMENTS_PER_PROJECT } from "./quota.js";

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

describe("POST /projects/:projectId/environments/ci", () => {
  it("creates an environment of type ci, with a generated name and ttl_at in the future", async () => {
    const { token, projectId } = await setupProject();

    const before = Date.now();
    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/environments/ci`,
      headers: auth(token),
      payload: { ttlSeconds: 600 },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.type).toBe("ci");
    expect(body.name).toMatch(/^ci-[0-9a-f]+$/);
    expect(new Date(body.ttlAt).getTime()).toBeGreaterThan(before + 599_000);
  });

  it("inherits the production environment as its parent when there's no staging", async () => {
    const { token, projectId } = await setupProject();

    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/environments/ci`,
      headers: auth(token),
      payload: { ttlSeconds: 600 },
    });

    const list = await app.inject({ method: "GET", url: `/v1/projects/${projectId}/environments`, headers: auth(token) });
    const production = list.json().data.find((e: { name: string }) => e.name === "production");
    expect(res.json().parentEnvironmentId).toBe(production.id);
  });

  it("accepts an explicit name", async () => {
    const { token, projectId } = await setupProject();

    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/environments/ci`,
      headers: auth(token),
      payload: { name: "nightly-e2e", ttlSeconds: 600 },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe("nightly-e2e");
  });

  it("returns 409 for a duplicate name in the same project", async () => {
    const { token, projectId } = await setupProject();
    const payload = { name: "nightly-e2e", ttlSeconds: 600 };
    await app.inject({ method: "POST", url: `/v1/projects/${projectId}/environments/ci`, headers: auth(token), payload });

    const res = await app.inject({ method: "POST", url: `/v1/projects/${projectId}/environments/ci`, headers: auth(token), payload });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("name_taken");
  });

  it("rejects a ttlSeconds outside the allowed range", async () => {
    const { token, projectId } = await setupProject();

    const tooShort = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/environments/ci`,
      headers: auth(token),
      payload: { ttlSeconds: 1 },
    });
    expect(tooShort.statusCode).toBe(400);

    const tooLong = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/environments/ci`,
      headers: auth(token),
      payload: { ttlSeconds: 60 * 60 * 24 },
    });
    expect(tooLong.statusCode).toBe(400);
  });

  it("enforces the per-project environment quota", async () => {
    const { token, projectId } = await setupProject();
    // The project already has one environment (production); fill up to the limit.
    for (let i = 1; i < MAX_ENVIRONMENTS_PER_PROJECT; i++) {
      const res = await app.inject({
        method: "POST",
        url: `/v1/projects/${projectId}/environments/ci`,
        headers: auth(token),
        payload: { ttlSeconds: 600 },
      });
      expect(res.statusCode).toBe(201);
    }

    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/environments/ci`,
      headers: auth(token),
      payload: { ttlSeconds: 600 },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("quota_exceeded");
  });

  it("prevents a viewer from creating one", async () => {
    const { projectId, orgId } = await setupProject();
    const viewer = await createUserWithToken(db, "viewer");
    await db.insert(memberships).values({ organizationId: orgId, userId: viewer.user.id, role: "viewer" });

    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/environments/ci`,
      headers: auth(viewer.token),
      payload: { ttlSeconds: 600 },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("forbidden");
  });

  it("returns 404 for a project in another organization", async () => {
    const { projectId } = await setupProject();
    const outsider = await createUserWithToken(db, "outsider");

    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/environments/ci`,
      headers: auth(outsider.token),
      payload: { ttlSeconds: 600 },
    });
    expect(res.statusCode).toBe(404);
  });

  it("repeating with the same Idempotency-Key does not create another environment", async () => {
    const { token, projectId } = await setupProject();
    const headers = auth(token, { "idempotency-key": "ci-env-1" });
    const payload = { ttlSeconds: 600 };
    const a = await app.inject({ method: "POST", url: `/v1/projects/${projectId}/environments/ci`, headers, payload });
    const b = await app.inject({ method: "POST", url: `/v1/projects/${projectId}/environments/ci`, headers, payload });
    expect(b.json().id).toBe(a.json().id);

    const list = await app.inject({ method: "GET", url: `/v1/projects/${projectId}/environments`, headers: auth(token) });
    expect(list.json().data.filter((e: { type: string }) => e.type === "ci")).toHaveLength(1);
  });
});

describe("DELETE /projects/:projectId/environments/:environmentId", () => {
  async function createCiEnv(token: string, projectId: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/environments/ci`,
      headers: auth(token),
      payload: { ttlSeconds: 600 },
    });
    return res.json().id as string;
  }

  it("marks the environment's ttl_at as due immediately", async () => {
    const { token, projectId } = await setupProject();
    const envId = await createCiEnv(token, projectId);

    const before = Date.now();
    const res = await app.inject({ method: "DELETE", url: `/v1/projects/${projectId}/environments/${envId}`, headers: auth(token) });

    expect(res.statusCode).toBe(204);
    const list = await app.inject({ method: "GET", url: `/v1/projects/${projectId}/environments`, headers: auth(token) });
    const env = list.json().data.find((e: { id: string }) => e.id === envId);
    expect(new Date(env.ttlAt).getTime()).toBeLessThanOrEqual(before + 1000);
  });

  it("refuses to delete a non-ci environment (e.g. production)", async () => {
    const { token, projectId } = await setupProject();
    const list = await app.inject({ method: "GET", url: `/v1/projects/${projectId}/environments`, headers: auth(token) });
    const production = list.json().data.find((e: { name: string }) => e.name === "production");

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/projects/${projectId}/environments/${production.id}`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("forbidden");
  });

  it("returns 404 for a nonexistent environment", async () => {
    const { token, projectId } = await setupProject();
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/projects/${projectId}/environments/00000000-0000-0000-0000-000000000000`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(404);
  });

  it("prevents a viewer from deleting one", async () => {
    const { token, projectId, orgId } = await setupProject();
    const envId = await createCiEnv(token, projectId);
    const viewer = await createUserWithToken(db, "viewer");
    await db.insert(memberships).values({ organizationId: orgId, userId: viewer.user.id, role: "viewer" });

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/projects/${projectId}/environments/${envId}`,
      headers: auth(viewer.token),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("forbidden");
  });
});
