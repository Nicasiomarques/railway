import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { db } from "./db/client.js";
import { createUserWithToken } from "./db/fixtures.js";
import { memberships } from "./db/schema.js";
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
const SECRET = "whsec_at_least_16_chars";

function installExtension(token: string, organizationId: string, payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: `/v1/organizations/${organizationId}/extensions`, headers: auth(token), payload });
}

describe("extensions", () => {
  it("installs an extension with a name and description", async () => {
    const { token, org } = await createUserWithToken(db);
    const res = await installExtension(token, org.id, {
      name: "Slack Notifier",
      description: "Posts deployment events to a Slack channel",
      url: "https://example.com/hook",
      secret: SECRET,
      events: ["deployment.status_changed"],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe("Slack Notifier");
    expect(res.json().description).toBe("Posts deployment events to a Slack channel");
    expect(res.json().secret).toBeUndefined();
  });

  it("lists only extensions, not plain webhook subscriptions", async () => {
    const { token, org } = await createUserWithToken(db);
    await installExtension(token, org.id, {
      name: "Slack Notifier",
      description: "Posts deployment events",
      url: "https://example.com/hook",
      secret: SECRET,
      events: ["deployment.status_changed"],
    });
    await app.inject({
      method: "POST",
      url: `/v1/organizations/${org.id}/webhook-subscriptions`,
      headers: auth(token),
      payload: { url: "https://example.com/plain", secret: SECRET, events: ["deployment.status_changed"] },
    });

    const list = await app.inject({ method: "GET", url: `/v1/organizations/${org.id}/extensions`, headers: auth(token) });
    expect(list.json().data).toHaveLength(1);
    expect(list.json().data[0].name).toBe("Slack Notifier");
  });

  it("uninstalls an extension, but not through the plain webhook-subscriptions route's id reuse", async () => {
    const { token, org } = await createUserWithToken(db);
    const created = await installExtension(token, org.id, {
      name: "Slack Notifier",
      description: "Posts deployment events",
      url: "https://example.com/hook",
      secret: SECRET,
      events: ["deployment.status_changed"],
    });
    const extensionId = created.json().id;

    const del = await app.inject({
      method: "DELETE",
      url: `/v1/organizations/${org.id}/extensions/${extensionId}`,
      headers: auth(token),
    });
    expect(del.statusCode).toBe(204);

    const list = await app.inject({ method: "GET", url: `/v1/organizations/${org.id}/extensions`, headers: auth(token) });
    expect(list.json().data).toHaveLength(0);
  });

  it("returns 404 uninstalling a plain webhook subscription through the extensions route", async () => {
    const { token, org } = await createUserWithToken(db);
    const sub = await app.inject({
      method: "POST",
      url: `/v1/organizations/${org.id}/webhook-subscriptions`,
      headers: auth(token),
      payload: { url: "https://example.com/plain", secret: SECRET, events: ["deployment.status_changed"] },
    });

    const del = await app.inject({
      method: "DELETE",
      url: `/v1/organizations/${org.id}/extensions/${sub.json().id}`,
      headers: auth(token),
    });
    expect(del.statusCode).toBe(404);
    expect(del.json().code).toBe("extension_not_found");
  });

  it("rejects an extension with no name", async () => {
    const { token, org } = await createUserWithToken(db);
    const res = await installExtension(token, org.id, {
      description: "Posts deployment events",
      url: "https://example.com/hook",
      secret: SECRET,
      events: ["deployment.status_changed"],
    });
    expect(res.statusCode).toBe(400);
  });

  it("prevents a viewer from installing or uninstalling, but allows listing", async () => {
    const { token: ownerToken, org } = await createUserWithToken(db);
    const viewer = await createUserWithToken(db, "viewer");
    await db.insert(memberships).values({ organizationId: org.id, userId: viewer.user.id, role: "viewer" });

    const install = await installExtension(viewer.token, org.id, {
      name: "Slack Notifier",
      description: "Posts deployment events",
      url: "https://example.com/hook",
      secret: SECRET,
      events: ["deployment.status_changed"],
    });
    expect(install.statusCode).toBe(403);

    const list = await app.inject({ method: "GET", url: `/v1/organizations/${org.id}/extensions`, headers: auth(viewer.token) });
    expect(list.statusCode).toBe(200);
  });

  it("writes an audit log entry on install and uninstall, without the secret", async () => {
    const { token, org } = await createUserWithToken(db);
    const created = await installExtension(token, org.id, {
      name: "Slack Notifier",
      description: "Posts deployment events",
      url: "https://example.com/hook",
      secret: SECRET,
      events: ["deployment.status_changed"],
    });
    await app.inject({
      method: "DELETE",
      url: `/v1/organizations/${org.id}/extensions/${created.json().id}`,
      headers: auth(token),
    });

    const logs = await app.inject({ method: "GET", url: `/v1/organizations/${org.id}/audit-logs`, headers: auth(token) });
    const actions = logs.json().data.map((l: { action: string }) => l.action);
    expect(actions).toEqual(expect.arrayContaining(["extension.install", "extension.uninstall"]));
    expect(JSON.stringify(logs.json())).not.toContain(SECRET);
  });
});
