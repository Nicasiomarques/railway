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
  return { token, projectId: project.id as string, orgId: org.id };
}

describe("canvas layout", () => {
  it("starts empty for a new project", async () => {
    const { token, projectId } = await setup();
    const res = await app.inject({ method: "GET", url: `/v1/projects/${projectId}/canvas-layout`, headers: auth(token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().layout).toEqual({});
  });

  it("saves and returns the layout", async () => {
    const { token, projectId } = await setup();
    const serviceId = "11111111-1111-1111-1111-111111111111";
    const layout = { [serviceId]: { x: 40, y: 120 } };

    const update = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectId}/canvas-layout`,
      headers: auth(token),
      payload: { layout },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().layout).toEqual(layout);

    const get = await app.inject({ method: "GET", url: `/v1/projects/${projectId}/canvas-layout`, headers: auth(token) });
    expect(get.json().layout).toEqual(layout);
  });

  it("replaces the previous layout rather than merging it", async () => {
    const { token, projectId } = await setup();
    const a = "11111111-1111-1111-1111-111111111111";
    const b = "22222222-2222-2222-2222-222222222222";

    await app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectId}/canvas-layout`,
      headers: auth(token),
      payload: { layout: { [a]: { x: 0, y: 0 } } },
    });
    const second = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectId}/canvas-layout`,
      headers: auth(token),
      payload: { layout: { [b]: { x: 10, y: 10 } } },
    });
    expect(second.json().layout).toEqual({ [b]: { x: 10, y: 10 } });
  });

  it("prevents a viewer from saving the layout", async () => {
    const { token, projectId, orgId } = await setup();
    const viewer = await createUserWithToken(db, "viewer");
    await db.insert(memberships).values({ organizationId: orgId, userId: viewer.user.id, role: "viewer" });

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectId}/canvas-layout`,
      headers: auth(viewer.token),
      payload: { layout: {} },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 404 for a project outside the user's organization", async () => {
    const { projectId } = await setup();
    const outsider = await createUserWithToken(db);
    const res = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/canvas-layout`,
      headers: auth(outsider.token),
    });
    expect(res.statusCode).toBe(404);
  });
});
