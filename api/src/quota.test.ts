import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { testKeyring } from "./crypto/testing.js";
import { db } from "./db/client.js";
import { projects } from "./db/schema.js";
import { createUserWithToken } from "./db/fixtures.js";
import { MAX_PROJECTS_PER_ORGANIZATION, MAX_SERVICES_PER_PROJECT } from "./quota.js";

// A generous rate limit, explicitly injected, so these tests never trip the per-user limiter
// from rate-limit.test.ts's concern - this file only cares about creation quotas.
const app = buildApp(db, { keyring: testKeyring(), rateLimit: { max: 1000, windowMs: 60_000 } });

beforeEach(async () => {
  const { rows } = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public' and tablename not in ('__drizzle_migrations', 'regions')`,
  );
  await db.execute(sql.raw(`truncate ${rows.map((r) => `"${r.tablename}"`).join(", ")} restart identity cascade`));
});

afterAll(async () => {
  await app.close();
});

function authed(token: string) {
  return { authorization: `Bearer ${token}` };
}

function createProject(token: string, organizationId: string, name: string) {
  return app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: authed(token),
    payload: { organizationId, name },
  });
}

function createService(token: string, projectId: string, name: string) {
  return app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/services`,
    headers: authed(token),
    payload: { name, kind: "web", source: "image" },
  });
}

describe("project creation quota", () => {
  it(`allows up to ${MAX_PROJECTS_PER_ORGANIZATION} projects per organization, and rejects the next one with 403 quota_exceeded`, async () => {
    const { token, org } = await createUserWithToken(db, "quota-projects");

    for (let i = 1; i <= MAX_PROJECTS_PER_ORGANIZATION; i++) {
      const res = await createProject(token, org.id, `project-${i}`);
      expect(res.statusCode).toBe(201);
    }

    const blocked = await createProject(token, org.id, `project-${MAX_PROJECTS_PER_ORGANIZATION + 1}`);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.headers["content-type"]).toContain("application/problem+json");
    expect(blocked.json().code).toBe("quota_exceeded");
  });

  it("does not count soft-deleted projects against the quota", async () => {
    const { token, org } = await createUserWithToken(db, "quota-projects-deleted");

    // Fill the quota, then soft-delete one directly (there's no delete route yet) and confirm
    // room opens up again - the count only looks at deleted_at IS NULL.
    const ids: string[] = [];
    for (let i = 1; i <= MAX_PROJECTS_PER_ORGANIZATION; i++) {
      const res = await createProject(token, org.id, `del-project-${i}`);
      expect(res.statusCode).toBe(201);
      ids.push(res.json().id);
    }

    await db.update(projects).set({ deletedAt: new Date() }).where(eq(projects.id, ids[0]));

    const res = await createProject(token, org.id, "del-project-replacement");
    expect(res.statusCode).toBe(201);
  });
});

describe("service creation quota", () => {
  it(`allows up to ${MAX_SERVICES_PER_PROJECT} services per project, and rejects the next one with 403 quota_exceeded`, async () => {
    const { token, org } = await createUserWithToken(db, "quota-services");
    const projectRes = await createProject(token, org.id, "service-quota-project");
    expect(projectRes.statusCode).toBe(201);
    const projectId = projectRes.json().id;

    for (let i = 1; i <= MAX_SERVICES_PER_PROJECT; i++) {
      const res = await createService(token, projectId, `service-${i}`);
      expect(res.statusCode).toBe(201);
    }

    const blocked = await createService(token, projectId, `service-${MAX_SERVICES_PER_PROJECT + 1}`);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.headers["content-type"]).toContain("application/problem+json");
    expect(blocked.json().code).toBe("quota_exceeded");
  });
});
