import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { testKeyring } from "./crypto/testing.js";
import { db } from "./db/client.js";
import { createUserWithToken } from "./db/fixtures.js";
import { memberships } from "./db/schema.js";

const app = buildApp(db, { keyring: testKeyring() });
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeEach(async () => {
  const { rows } = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public' and tablename not in ('__drizzle_migrations', 'regions')`,
  );
  await db.execute(sql.raw(`truncate ${rows.map((r) => `"${r.tablename}"`).join(", ")} restart identity cascade`));
});

afterAll(async () => {
  await app.close();
});

async function setupInstance(token: string, organizationId: string): Promise<string> {
  const project = await app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: auth(token),
    payload: { organizationId, name: "Web" },
  });
  const service = await app.inject({
    method: "POST",
    url: `/v1/projects/${project.json().id}/services`,
    headers: auth(token),
    payload: { name: "api", kind: "web", source: "image" },
  });
  return service.json().instances[0].id as string;
}

describe("GET /v1/services/:instanceId/autoscaling", () => {
  it("a fresh instance has autoscaling disabled with the default replica count", async () => {
    const { token, org } = await createUserWithToken(db);
    const instanceId = await setupInstance(token, org.id);

    const res = await app.inject({ method: "GET", url: `/v1/services/${instanceId}/autoscaling`, headers: auth(token) });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      instanceId,
      enabled: false,
      replicas: 1,
      minReplicas: null,
      maxReplicas: null,
      targetCpuPercent: null,
      cpuRequestMillicores: null,
    });
  });

  it("a nonexistent instance returns 404", async () => {
    const { token } = await createUserWithToken(db);

    const res = await app.inject({
      method: "GET",
      url: "/v1/services/00000000-0000-0000-0000-000000000000/autoscaling",
      headers: auth(token),
    });

    expect(res.statusCode).toBe(404);
  });
});

describe("PUT /v1/services/:instanceId/autoscaling", () => {
  it("enables autoscaling with a policy", async () => {
    const { token, org } = await createUserWithToken(db);
    const instanceId = await setupInstance(token, org.id);

    const res = await app.inject({
      method: "PUT",
      url: `/v1/services/${instanceId}/autoscaling`,
      headers: auth(token),
      payload: { enabled: true, minReplicas: 2, maxReplicas: 10, targetCpuPercent: 70, cpuRequestMillicores: 250 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      enabled: true,
      minReplicas: 2,
      maxReplicas: 10,
      targetCpuPercent: 70,
      cpuRequestMillicores: 250,
    });
  });

  it("enabling without the required fields is a 400", async () => {
    const { token, org } = await createUserWithToken(db);
    const instanceId = await setupInstance(token, org.id);

    const res = await app.inject({
      method: "PUT",
      url: `/v1/services/${instanceId}/autoscaling`,
      headers: auth(token),
      payload: { enabled: true, minReplicas: 2 },
    });

    expect(res.statusCode).toBe(400);
  });

  it("minReplicas greater than maxReplicas is a 400", async () => {
    const { token, org } = await createUserWithToken(db);
    const instanceId = await setupInstance(token, org.id);

    const res = await app.inject({
      method: "PUT",
      url: `/v1/services/${instanceId}/autoscaling`,
      headers: auth(token),
      payload: { enabled: true, minReplicas: 10, maxReplicas: 2, targetCpuPercent: 70, cpuRequestMillicores: 250 },
    });

    expect(res.statusCode).toBe(400);
  });

  it("disabling clears the policy fields and can set a new fixed replica count", async () => {
    const { token, org } = await createUserWithToken(db);
    const instanceId = await setupInstance(token, org.id);
    await app.inject({
      method: "PUT",
      url: `/v1/services/${instanceId}/autoscaling`,
      headers: auth(token),
      payload: { enabled: true, minReplicas: 2, maxReplicas: 10, targetCpuPercent: 70, cpuRequestMillicores: 250 },
    });

    const res = await app.inject({
      method: "PUT",
      url: `/v1/services/${instanceId}/autoscaling`,
      headers: auth(token),
      payload: { enabled: false, replicas: 4 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      instanceId,
      enabled: false,
      replicas: 4,
      minReplicas: null,
      maxReplicas: null,
      targetCpuPercent: null,
      cpuRequestMillicores: null,
    });
  });

  it("a viewer cannot change the policy", async () => {
    const { token, org } = await createUserWithToken(db);
    const instanceId = await setupInstance(token, org.id);
    await db.update(memberships).set({ role: "viewer" }).where(sql`organization_id = ${org.id}`);

    const res = await app.inject({
      method: "PUT",
      url: `/v1/services/${instanceId}/autoscaling`,
      headers: auth(token),
      payload: { enabled: true, minReplicas: 2, maxReplicas: 10, targetCpuPercent: 70, cpuRequestMillicores: 250 },
    });

    expect(res.statusCode).toBe(403);
  });
});
