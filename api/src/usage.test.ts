import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { testKeyring } from "./crypto/testing.js";
import { db } from "./db/client.js";
import { createUserWithToken } from "./db/fixtures.js";
import { memberships, usageEvents } from "./db/schema.js";

const app = buildApp(db, { keyring: testKeyring() });
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeEach(async () => {
  const { rows } = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public' and tablename <> '__drizzle_migrations'`,
  );
  await db.execute(sql.raw(`truncate ${rows.map((r) => `"${r.tablename}"`).join(", ")} restart identity cascade`));
});

afterAll(async () => {
  await app.close();
});

async function setupProjectWithInstance(token: string, orgId: string) {
  const project = await app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: auth(token),
    payload: { organizationId: orgId, name: "Web" },
  });
  const service = await app.inject({
    method: "POST",
    url: `/v1/projects/${project.json().id}/services`,
    headers: auth(token),
    payload: { name: "api", kind: "web", source: "image" },
  });
  return {
    projectId: project.json().id as string,
    serviceInstanceId: service.json().instances[0].id as string,
  };
}

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

describe("GET /v1/organizations/:organizationId/usage", () => {
  it("sums replica_minutes per project and service instance within the default 30-day window", async () => {
    const { token, org } = await createUserWithToken(db);
    const { projectId, serviceInstanceId } = await setupProjectWithInstance(token, org.id);

    await db.insert(usageEvents).values([
      { projectId, serviceInstanceId, metric: "replica_minutes", value: 1, occurredAt: daysAgo(10) },
      { projectId, serviceInstanceId, metric: "replica_minutes", value: 2, occurredAt: daysAgo(5) },
      // Outside the default 30-day window: must not be counted.
      { projectId, serviceInstanceId, metric: "replica_minutes", value: 100, occurredAt: daysAgo(40) },
    ]);

    const res = await app.inject({ method: "GET", url: `/v1/organizations/${org.id}/usage`, headers: auth(token) });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([
      {
        projectId,
        projectName: "Web",
        serviceInstanceId,
        serviceName: "api",
        totalReplicaMinutes: 3,
        sampleCount: 2,
      },
    ]);
  });

  it("aggregates a project-level sample (no serviceInstanceId) separately from per-instance samples", async () => {
    const { token, org } = await createUserWithToken(db);
    const { projectId, serviceInstanceId } = await setupProjectWithInstance(token, org.id);

    await db.insert(usageEvents).values([
      { projectId, serviceInstanceId, metric: "replica_minutes", value: 4, occurredAt: daysAgo(1) },
      { projectId, serviceInstanceId: null, metric: "replica_minutes", value: 7, occurredAt: daysAgo(1) },
    ]);

    const res = await app.inject({ method: "GET", url: `/v1/organizations/${org.id}/usage`, headers: auth(token) });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual(
      expect.arrayContaining([
        { projectId, projectName: "Web", serviceInstanceId, serviceName: "api", totalReplicaMinutes: 4, sampleCount: 1 },
        { projectId, projectName: "Web", serviceInstanceId: null, serviceName: null, totalReplicaMinutes: 7, sampleCount: 1 },
      ]),
    );
    expect(res.json().data).toHaveLength(2);
  });

  it("ignores other metrics and respects an explicit from/to range", async () => {
    const { token, org } = await createUserWithToken(db);
    const { projectId, serviceInstanceId } = await setupProjectWithInstance(token, org.id);

    await db.insert(usageEvents).values([
      { projectId, serviceInstanceId, metric: "replica_minutes", value: 5, occurredAt: daysAgo(3) },
      // A different metric: not part of totalReplicaMinutes even though it's in range.
      { projectId, serviceInstanceId, metric: "disk_bytes", value: 999, occurredAt: daysAgo(3) },
      // In range for the default window, but outside the explicit range requested below.
      { projectId, serviceInstanceId, metric: "replica_minutes", value: 50, occurredAt: daysAgo(20) },
    ]);

    const from = daysAgo(4).toISOString();
    const to = daysAgo(2).toISOString();
    const res = await app.inject({
      method: "GET",
      url: `/v1/organizations/${org.id}/usage?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      headers: auth(token),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([
      { projectId, projectName: "Web", serviceInstanceId, serviceName: "api", totalReplicaMinutes: 5, sampleCount: 1 },
    ]);
  });

  it("returns no rows for an organization with no usage_events yet", async () => {
    const { token, org } = await createUserWithToken(db);
    await setupProjectWithInstance(token, org.id);

    const res = await app.inject({ method: "GET", url: `/v1/organizations/${org.id}/usage`, headers: auth(token) });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([]);
  });

  it("any role, including viewer, can read usage", async () => {
    const { token, org } = await createUserWithToken(db);
    await db.update(memberships).set({ role: "viewer" }).where(sql`organization_id = ${org.id}`);

    const res = await app.inject({ method: "GET", url: `/v1/organizations/${org.id}/usage`, headers: auth(token) });

    expect(res.statusCode).toBe(200);
  });

  it("a nonexistent organization returns 404", async () => {
    const { token } = await createUserWithToken(db);

    const res = await app.inject({
      method: "GET",
      url: "/v1/organizations/00000000-0000-0000-0000-000000000000/usage",
      headers: auth(token),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("organization_not_found");
  });

  it("someone who isn't a member gets the same 404 as a nonexistent organization", async () => {
    const owner = await createUserWithToken(db);
    const outsider = await createUserWithToken(db);

    const res = await app.inject({
      method: "GET",
      url: `/v1/organizations/${owner.org.id}/usage`,
      headers: auth(outsider.token),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("organization_not_found");
  });
});
