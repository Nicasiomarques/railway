import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { testKeyring } from "./crypto/testing.js";
import { db } from "./db/client.js";
import { createUserWithToken } from "./db/fixtures.js";
import { invoiceLineItems, invoices, memberships, plans } from "./db/schema.js";

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

// The migration seeds "free"/"pro", but the blanket truncate above (shared with every other test
// file) wipes that reference data along with everything else -- so each test creates the plan rows
// it needs directly, the same way usage.test.ts inserts usage_events directly rather than going
// through a worker.
async function createPlan(overrides: Partial<typeof plans.$inferInsert> = {}) {
  const [plan] = await db
    .insert(plans)
    .values({ slug: "pro", name: "Pro", pricePerReplicaMinuteCents: 1, includedReplicaMinutes: 1000, ...overrides })
    .returning();
  return plan;
}

describe("GET /v1/organizations/:organizationId/plans", () => {
  it("lists plans ordered by price", async () => {
    const { token, org } = await createUserWithToken(db);
    await createPlan({ slug: "pro", pricePerReplicaMinuteCents: 1 });
    await createPlan({ slug: "free", pricePerReplicaMinuteCents: 0 });

    const res = await app.inject({ method: "GET", url: `/v1/organizations/${org.id}/plans`, headers: auth(token) });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.map((p: { slug: string }) => p.slug)).toEqual(["free", "pro"]);
  });
});

describe("subscription", () => {
  it("getting a subscription before one is set returns 404", async () => {
    const { token, org } = await createUserWithToken(db);

    const res = await app.inject({ method: "GET", url: `/v1/organizations/${org.id}/subscription`, headers: auth(token) });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("subscription_not_found");
  });

  it("an owner can set the plan, and it comes back from a GET", async () => {
    const { token, org } = await createUserWithToken(db);
    await createPlan({ slug: "pro" });

    const put = await app.inject({
      method: "PUT",
      url: `/v1/organizations/${org.id}/subscription`,
      headers: auth(token),
      payload: { planSlug: "pro" },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().plan.slug).toBe("pro");

    const get = await app.inject({ method: "GET", url: `/v1/organizations/${org.id}/subscription`, headers: auth(token) });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ organizationId: org.id, status: "active", plan: { slug: "pro" } });
  });

  it("changing plans updates the existing subscription instead of creating a second one", async () => {
    const { token, org } = await createUserWithToken(db);
    await createPlan({ slug: "pro" });
    await createPlan({ slug: "free", pricePerReplicaMinuteCents: 0, includedReplicaMinutes: 0 });

    await app.inject({ method: "PUT", url: `/v1/organizations/${org.id}/subscription`, headers: auth(token), payload: { planSlug: "pro" } });
    const res = await app.inject({
      method: "PUT",
      url: `/v1/organizations/${org.id}/subscription`,
      headers: auth(token),
      payload: { planSlug: "free" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().plan.slug).toBe("free");
  });

  it("a member cannot change the plan", async () => {
    const { token, org } = await createUserWithToken(db);
    await createPlan({ slug: "pro" });
    await db.update(memberships).set({ role: "member" }).where(sql`organization_id = ${org.id}`);

    const res = await app.inject({
      method: "PUT",
      url: `/v1/organizations/${org.id}/subscription`,
      headers: auth(token),
      payload: { planSlug: "pro" },
    });

    expect(res.statusCode).toBe(403);
  });

  it("an unknown plan slug returns 404", async () => {
    const { token, org } = await createUserWithToken(db);

    const res = await app.inject({
      method: "PUT",
      url: `/v1/organizations/${org.id}/subscription`,
      headers: auth(token),
      payload: { planSlug: "nope" },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("plan_not_found");
  });
});

describe("invoices", () => {
  async function createInvoice(organizationId: string, planId: string, overrides: Partial<typeof invoices.$inferInsert> = {}) {
    const [invoice] = await db
      .insert(invoices)
      .values({
        organizationId,
        planId,
        periodStart: new Date("2026-01-01T00:00:00Z"),
        periodEnd: new Date("2026-02-01T00:00:00Z"),
        totalCents: 500,
        ...overrides,
      })
      .returning();
    return invoice;
  }

  it("lists invoices for the organization, most recent period first", async () => {
    const { token, org } = await createUserWithToken(db);
    const plan = await createPlan();
    await createInvoice(org.id, plan.id, { periodStart: new Date("2026-01-01T00:00:00Z"), periodEnd: new Date("2026-02-01T00:00:00Z") });
    await createInvoice(org.id, plan.id, { periodStart: new Date("2026-02-01T00:00:00Z"), periodEnd: new Date("2026-03-01T00:00:00Z") });

    const res = await app.inject({ method: "GET", url: `/v1/organizations/${org.id}/invoices`, headers: auth(token) });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.map((i: { periodStart: string }) => i.periodStart)).toEqual([
      "2026-02-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    ]);
  });

  it("another organization's invoices are not visible", async () => {
    const owner = await createUserWithToken(db);
    const outsider = await createUserWithToken(db);
    const plan = await createPlan();
    await createInvoice(owner.org.id, plan.id);

    const res = await app.inject({ method: "GET", url: `/v1/organizations/${owner.org.id}/invoices`, headers: auth(outsider.token) });

    expect(res.statusCode).toBe(404);
  });

  it("gets an invoice with its line items, including the project name", async () => {
    const { token, org } = await createUserWithToken(db);
    const plan = await createPlan();
    const invoice = await createInvoice(org.id, plan.id);
    const project = await app.inject({ method: "POST", url: "/v1/projects", headers: auth(token), payload: { organizationId: org.id, name: "Web" } });
    await db.insert(invoiceLineItems).values({
      invoiceId: invoice.id,
      projectId: project.json().id,
      description: "Web - replica-minutes",
      replicaMinutes: 500,
      amountCents: 500,
    });

    const res = await app.inject({ method: "GET", url: `/v1/organizations/${org.id}/invoices/${invoice.id}`, headers: auth(token) });

    expect(res.statusCode).toBe(200);
    expect(res.json().lineItems).toEqual([
      {
        id: expect.any(String),
        projectId: project.json().id,
        projectName: "Web",
        description: "Web - replica-minutes",
        replicaMinutes: 500,
        amountCents: 500,
      },
    ]);
  });

  it("a nonexistent invoice returns 404", async () => {
    const { token, org } = await createUserWithToken(db);

    const res = await app.inject({
      method: "GET",
      url: `/v1/organizations/${org.id}/invoices/00000000-0000-0000-0000-000000000000`,
      headers: auth(token),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("invoice_not_found");
  });

  it("an owner can finalize a draft invoice, after which it cannot be finalized again", async () => {
    const { token, org } = await createUserWithToken(db);
    const plan = await createPlan();
    const invoice = await createInvoice(org.id, plan.id);

    const first = await app.inject({ method: "POST", url: `/v1/organizations/${org.id}/invoices/${invoice.id}/finalize`, headers: auth(token) });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: "finalized" });
    expect(first.json().finalizedAt).not.toBeNull();

    const second = await app.inject({ method: "POST", url: `/v1/organizations/${org.id}/invoices/${invoice.id}/finalize`, headers: auth(token) });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("invoice_already_finalized");
  });

  it("a member cannot finalize an invoice", async () => {
    const { token, org } = await createUserWithToken(db);
    const plan = await createPlan();
    const invoice = await createInvoice(org.id, plan.id);
    await db.update(memberships).set({ role: "member" }).where(sql`organization_id = ${org.id}`);

    const res = await app.inject({ method: "POST", url: `/v1/organizations/${org.id}/invoices/${invoice.id}/finalize`, headers: auth(token) });

    expect(res.statusCode).toBe(403);
  });
});
