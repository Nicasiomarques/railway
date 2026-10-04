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

function createSubscription(token: string, organizationId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/v1/organizations/${organizationId}/webhook-subscriptions`,
    headers: auth(token),
    payload,
  });
}

function listSubscriptions(token: string, organizationId: string) {
  return app.inject({ method: "GET", url: `/v1/organizations/${organizationId}/webhook-subscriptions`, headers: auth(token) });
}

function deleteSubscription(token: string, organizationId: string, subscriptionId: string) {
  return app.inject({
    method: "DELETE",
    url: `/v1/organizations/${organizationId}/webhook-subscriptions/${subscriptionId}`,
    headers: auth(token),
  });
}

async function createProject(token: string, organizationId: string, name = "Web"): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/v1/projects", headers: auth(token), payload: { organizationId, name } });
  return res.json().id;
}

describe("webhook subscriptions", () => {
  it("creates an organization-wide subscription (no projectId) and never returns the secret", async () => {
    const { token, org } = await createUserWithToken(db);

    const res = await createSubscription(token, org.id, {
      url: "https://example.com/hooks",
      secret: SECRET,
      events: ["deployment.status_changed"],
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.organizationId).toBe(org.id);
    expect(body.projectId).toBeNull();
    expect(body.url).toBe("https://example.com/hooks");
    expect(body.events).toEqual(["deployment.status_changed"]);
    expect(body.isActive).toBe(true);
    expect(body.secret).toBeUndefined();
  });

  it("creates a project-scoped subscription", async () => {
    const { token, org } = await createUserWithToken(db);
    const projectId = await createProject(token, org.id);

    const res = await createSubscription(token, org.id, {
      projectId,
      url: "https://example.com/hooks",
      secret: SECRET,
      events: ["deployment.status_changed"],
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().projectId).toBe(projectId);
  });

  it("rejects a projectId that belongs to another organization", async () => {
    const { token, org } = await createUserWithToken(db);
    const other = await createUserWithToken(db, "other");
    const otherProjectId = await createProject(other.token, other.org.id);

    const res = await createSubscription(token, org.id, {
      projectId: otherProjectId,
      url: "https://example.com/hooks",
      secret: SECRET,
      events: ["deployment.status_changed"],
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("project_not_found");
  });

  it("rejects an invalid url", async () => {
    const { token, org } = await createUserWithToken(db);
    const res = await createSubscription(token, org.id, {
      url: "not-a-url",
      secret: SECRET,
      events: ["deployment.status_changed"],
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an event type that isn't in the 'resource.event' form", async () => {
    const { token, org } = await createUserWithToken(db);
    const res = await createSubscription(token, org.id, {
      url: "https://example.com/hooks",
      secret: SECRET,
      events: ["not valid!"],
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an empty events list and a secret that's too short", async () => {
    const { token, org } = await createUserWithToken(db);

    const noEvents = await createSubscription(token, org.id, { url: "https://example.com/hooks", secret: SECRET, events: [] });
    expect(noEvents.statusCode).toBe(400);

    const shortSecret = await createSubscription(token, org.id, {
      url: "https://example.com/hooks",
      secret: "short",
      events: ["deployment.status_changed"],
    });
    expect(shortSecret.statusCode).toBe(400);
  });

  it("lists subscriptions without ever including the secret", async () => {
    const { token, org } = await createUserWithToken(db);
    await createSubscription(token, org.id, { url: "https://example.com/a", secret: SECRET, events: ["deployment.status_changed"] });
    await createSubscription(token, org.id, { url: "https://example.com/b", secret: SECRET, events: ["deployment.status_changed"] });

    const res = await listSubscriptions(token, org.id);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(2);
    for (const row of body.data) expect(row.secret).toBeUndefined();
  });

  it("deletes a subscription and returns 404 on a second delete", async () => {
    const { token, org } = await createUserWithToken(db);
    const created = (
      await createSubscription(token, org.id, { url: "https://example.com/hooks", secret: SECRET, events: ["deployment.status_changed"] })
    ).json();

    const del = await deleteSubscription(token, org.id, created.id);
    expect(del.statusCode).toBe(204);

    const again = await deleteSubscription(token, org.id, created.id);
    expect(again.statusCode).toBe(404);
    expect(again.json().code).toBe("webhook_subscription_not_found");
  });

  it("blocks a viewer from creating or deleting, but allows listing", async () => {
    const { token, org } = await createUserWithToken(db);
    const created = (
      await createSubscription(token, org.id, { url: "https://example.com/hooks", secret: SECRET, events: ["deployment.status_changed"] })
    ).json();
    const viewer = await createUserWithToken(db, "viewer");
    await db.insert(memberships).values({ organizationId: org.id, userId: viewer.user.id, role: "viewer" });

    const create = await createSubscription(viewer.token, org.id, {
      url: "https://example.com/other",
      secret: SECRET,
      events: ["deployment.status_changed"],
    });
    expect(create.statusCode).toBe(403);

    const del = await deleteSubscription(viewer.token, org.id, created.id);
    expect(del.statusCode).toBe(403);

    const list = await listSubscriptions(viewer.token, org.id);
    expect(list.statusCode).toBe(200);
  });

  it("returns 404 for an organization the caller doesn't belong to", async () => {
    const { org } = await createUserWithToken(db);
    const outsider = await createUserWithToken(db, "outsider");

    const res = await listSubscriptions(outsider.token, org.id);
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("organization_not_found");
  });

  it("writes an audit log entry on create and delete, without the secret", async () => {
    const { token, org } = await createUserWithToken(db);
    const created = (
      await createSubscription(token, org.id, { url: "https://example.com/hooks", secret: SECRET, events: ["deployment.status_changed"] })
    ).json();
    await deleteSubscription(token, org.id, created.id);

    const { rows } = await db.execute<{ action: string; metadata: unknown }>(
      sql`select action, metadata from audit_logs where action like 'webhook_subscription.%' order by occurred_at`,
    );
    expect(rows.map((r) => r.action)).toEqual(["webhook_subscription.create", "webhook_subscription.delete"]);
    for (const row of rows) {
      expect(JSON.stringify(row.metadata)).not.toContain(SECRET);
    }
  });
});
