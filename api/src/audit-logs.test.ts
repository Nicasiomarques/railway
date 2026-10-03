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
    sql`select tablename from pg_tables where schemaname = 'public' and tablename <> '__drizzle_migrations'`,
  );
  await db.execute(sql.raw(`truncate ${rows.map((r) => `"${r.tablename}"`).join(", ")} restart identity cascade`));
});

afterAll(async () => {
  await app.close();
});

describe("listing an organization's audit log", () => {
  it("lists entries created by other routes, most recent first", async () => {
    // createUserWithToken seeds the organization directly in the database (no audit entry);
    // the API routes below are what actually write to the audit log.
    const { token, org } = await createUserWithToken(db);
    const project = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: auth(token),
      payload: { organizationId: org.id, name: "Web" },
    });
    await app.inject({
      method: "POST",
      url: `/v1/projects/${project.json().id}/services`,
      headers: auth(token),
      payload: { name: "app", kind: "web", source: "image" },
    });

    const res = await app.inject({ method: "GET", url: `/v1/organizations/${org.id}/audit-logs`, headers: auth(token) });

    expect(res.statusCode).toBe(200);
    const actions = res.json().data.map((e: { action: string }) => e.action);
    expect(actions).toEqual(["service.create", "project.create"]);
    expect(res.json().data[0]).toMatchObject({
      action: "service.create",
      actorId: expect.any(String),
      target: expect.stringMatching(/^service:/),
    });
    expect(typeof res.json().data[0].id).toBe("string");
  });

  it("paginates by cursor without repeating or losing items", async () => {
    const { token, org } = await createUserWithToken(db);
    for (let i = 1; i <= 5; i++) {
      await app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: auth(token),
        payload: { organizationId: org.id, name: `Project ${i}` },
      });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const qs = new URLSearchParams({ limit: "2", ...(cursor ? { cursor } : {}) });
      const res = await app.inject({
        method: "GET",
        url: `/v1/organizations/${org.id}/audit-logs?${qs}`,
        headers: auth(token),
      });
      expect(res.statusCode).toBe(200);
      seen.push(...res.json().data.map((e: { id: string }) => e.id));
      cursor = res.json().nextCursor;
    } while (cursor);

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it("any role, including viewer, can read the audit log", async () => {
    const { token, org } = await createUserWithToken(db);
    await db.update(memberships).set({ role: "viewer" }).where(sql`organization_id = ${org.id}`);

    const res = await app.inject({ method: "GET", url: `/v1/organizations/${org.id}/audit-logs`, headers: auth(token) });

    expect(res.statusCode).toBe(200);
  });

  it("a nonexistent organization returns 404", async () => {
    const { token } = await createUserWithToken(db);

    const res = await app.inject({
      method: "GET",
      url: "/v1/organizations/00000000-0000-0000-0000-000000000000/audit-logs",
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
      url: `/v1/organizations/${owner.org.id}/audit-logs`,
      headers: auth(outsider.token),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("organization_not_found");
  });
});
