import type { FastifyPluginAsync } from "fastify";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { InvoiceDetailSchema, InvoiceSchema, PlanSchema, SubscriptionSchema, listOf } from "../openapi/schemas.js";
import { requireMembership } from "../access.js";
import { ApiError } from "../errors.js";
import type { Db } from "../db/client.js";
import { auditLogs, invoiceLineItems, invoices, organizationSubscriptions, plans, projects } from "../db/schema.js";

const organizationParams = z.object({ organizationId: z.string().uuid() });
const invoiceParams = organizationParams.extend({ invoiceId: z.string().uuid() });

const putSubscriptionBody = z.object({ planSlug: z.string() });

async function requireWriteMembership(db: Db, userId: string, organizationId: string): Promise<void> {
  const role = await requireMembership(db, userId, organizationId);
  if (role !== "owner" && role !== "admin") {
    throw new ApiError(403, "forbidden", "Only an owner or admin can manage billing.");
  }
}

function toPlanResponse(row: typeof plans.$inferSelect) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    pricePerReplicaMinuteCents: row.pricePerReplicaMinuteCents,
    includedReplicaMinutes: row.includedReplicaMinutes,
  };
}

function toInvoiceResponse(row: typeof invoices.$inferSelect) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    status: row.status,
    totalCents: row.totalCents,
    currency: row.currency,
    finalizedAt: row.finalizedAt,
    createdAt: row.createdAt,
  };
}

export const billingRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.get(
    "/organizations/:organizationId/plans",
    {
      config: {
        openapi: {
          operationId: "listPlans",
          tags: ["Billing"],
          summary: "Lists the pricing plans an organization can subscribe to",
          pathSchema: organizationParams,
          success: { status: 200, description: "Plans", schema: listOf(PlanSchema) },
          errors: [404],
        },
      },
    },
    async (request) => {
      const { organizationId } = organizationParams.parse(request.params);
      await requireMembership(db, request.auth!.userId, organizationId);

      const rows = await db.select().from(plans).orderBy(asc(plans.pricePerReplicaMinuteCents));
      return { data: rows.map(toPlanResponse) };
    },
  );

  app.get(
    "/organizations/:organizationId/subscription",
    {
      config: {
        openapi: {
          operationId: "getSubscription",
          tags: ["Billing"],
          summary: "Gets the organization's current plan; 404 if it has never picked one",
          pathSchema: organizationParams,
          success: { status: 200, description: "Subscription", schema: SubscriptionSchema },
          errors: [404],
        },
      },
    },
    async (request) => {
      const { organizationId } = organizationParams.parse(request.params);
      await requireMembership(db, request.auth!.userId, organizationId);

      const [row] = await db
        .select({ subscription: organizationSubscriptions, plan: plans })
        .from(organizationSubscriptions)
        .innerJoin(plans, eq(plans.id, organizationSubscriptions.planId))
        .where(eq(organizationSubscriptions.organizationId, organizationId));
      if (!row) throw new ApiError(404, "subscription_not_found", "This organization has not picked a plan yet.");

      return {
        organizationId: row.subscription.organizationId,
        plan: toPlanResponse(row.plan),
        status: row.subscription.status,
        createdAt: row.subscription.createdAt,
        updatedAt: row.subscription.updatedAt,
      };
    },
  );

  app.put(
    "/organizations/:organizationId/subscription",
    {
      config: {
        openapi: {
          operationId: "putSubscription",
          tags: ["Billing"],
          summary: "Sets or changes the organization's plan; the next billing period bills at the new rate",
          pathSchema: organizationParams,
          bodySchema: putSubscriptionBody,
          success: { status: 200, description: "Subscription", schema: SubscriptionSchema },
          errors: [403, 404],
        },
      },
    },
    async (request) => {
      const { organizationId } = organizationParams.parse(request.params);
      const body = putSubscriptionBody.parse(request.body);
      const userId = request.auth!.userId;
      await requireWriteMembership(db, userId, organizationId);

      const [plan] = await db.select().from(plans).where(eq(plans.slug, body.planSlug));
      if (!plan) throw new ApiError(404, "plan_not_found", `No plan with slug "${body.planSlug}".`);

      const [row] = await db
        .insert(organizationSubscriptions)
        .values({ organizationId, planId: plan.id, status: "active" })
        .onConflictDoUpdate({
          target: organizationSubscriptions.organizationId,
          set: { planId: plan.id, status: "active", updatedAt: new Date() },
        })
        .returning();

      await db.insert(auditLogs).values({
        organizationId,
        actorId: userId,
        action: "subscription.update",
        target: `plan:${plan.id}`,
        metadata: { planSlug: plan.slug },
      });

      return {
        organizationId: row.organizationId,
        plan: toPlanResponse(plan),
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    },
  );

  app.get(
    "/organizations/:organizationId/invoices",
    {
      config: {
        openapi: {
          operationId: "listInvoices",
          tags: ["Billing"],
          summary: "Lists the organization's invoices, most recent period first",
          pathSchema: organizationParams,
          success: { status: 200, description: "Invoices", schema: listOf(InvoiceSchema) },
          errors: [404],
        },
      },
    },
    async (request) => {
      const { organizationId } = organizationParams.parse(request.params);
      await requireMembership(db, request.auth!.userId, organizationId);

      const rows = await db
        .select()
        .from(invoices)
        .where(eq(invoices.organizationId, organizationId))
        .orderBy(desc(invoices.periodStart));
      return { data: rows.map(toInvoiceResponse) };
    },
  );

  app.get(
    "/organizations/:organizationId/invoices/:invoiceId",
    {
      config: {
        openapi: {
          operationId: "getInvoice",
          tags: ["Billing"],
          summary: "Gets one invoice with its per-project line items",
          pathSchema: invoiceParams,
          success: { status: 200, description: "Invoice", schema: InvoiceDetailSchema },
          errors: [404],
        },
      },
    },
    async (request) => {
      const { organizationId, invoiceId } = invoiceParams.parse(request.params);
      await requireMembership(db, request.auth!.userId, organizationId);

      const [invoice] = await db
        .select()
        .from(invoices)
        .where(and(eq(invoices.id, invoiceId), eq(invoices.organizationId, organizationId)));
      if (!invoice) throw new ApiError(404, "invoice_not_found", "Invoice not found.");

      const lineItems = await db
        .select({ item: invoiceLineItems, projectName: projects.name })
        .from(invoiceLineItems)
        .leftJoin(projects, eq(projects.id, invoiceLineItems.projectId))
        .where(eq(invoiceLineItems.invoiceId, invoiceId));

      return {
        ...toInvoiceResponse(invoice),
        lineItems: lineItems.map((row) => ({
          id: row.item.id,
          projectId: row.item.projectId,
          projectName: row.projectName,
          description: row.item.description,
          replicaMinutes: row.item.replicaMinutes,
          amountCents: row.item.amountCents,
        })),
      };
    },
  );

  app.post(
    "/organizations/:organizationId/invoices/:invoiceId/finalize",
    {
      config: {
        openapi: {
          operationId: "finalizeInvoice",
          tags: ["Billing"],
          summary: "Closes a draft invoice; its amounts become immutable",
          pathSchema: invoiceParams,
          success: { status: 200, description: "Invoice", schema: InvoiceSchema },
          errors: [403, 404, 409],
        },
      },
    },
    async (request) => {
      const { organizationId, invoiceId } = invoiceParams.parse(request.params);
      const userId = request.auth!.userId;
      await requireWriteMembership(db, userId, organizationId);

      const [invoice] = await db
        .select()
        .from(invoices)
        .where(and(eq(invoices.id, invoiceId), eq(invoices.organizationId, organizationId)));
      if (!invoice) throw new ApiError(404, "invoice_not_found", "Invoice not found.");
      if (invoice.status === "finalized") {
        throw new ApiError(409, "invoice_already_finalized", "This invoice is already finalized.");
      }

      const [updated] = await db
        .update(invoices)
        .set({ status: "finalized", finalizedAt: new Date(), updatedAt: new Date() })
        .where(eq(invoices.id, invoiceId))
        .returning();

      await db.insert(auditLogs).values({
        organizationId,
        actorId: userId,
        action: "invoice.finalize",
        target: `invoice:${invoiceId}`,
        metadata: { totalCents: updated.totalCents },
      });

      return toInvoiceResponse(updated);
    },
  );
};
