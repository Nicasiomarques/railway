import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";
import {
  invoiceLineItems,
  invoices,
  organizationSubscriptions,
  plans,
  projects,
  usageEvents,
  type Db,
} from "@railway-like/db";
import type { BillingStore, InvoiceInput, OrganizationSubscription, ProjectUsage, UpsertInvoiceResult } from "./store.js";

// Postgres store for the billing worker.
export class PostgresBillingStore implements BillingStore {
  constructor(private readonly db: Db) {}

  async listActiveSubscriptions(): Promise<OrganizationSubscription[]> {
    const rows = await this.db
      .select({
        organizationId: organizationSubscriptions.organizationId,
        planId: plans.id,
        pricePerReplicaMinuteCents: plans.pricePerReplicaMinuteCents,
        includedReplicaMinutes: plans.includedReplicaMinutes,
      })
      .from(organizationSubscriptions)
      .innerJoin(plans, eq(plans.id, organizationSubscriptions.planId))
      .where(eq(organizationSubscriptions.status, "active"));

    return rows.map((row) => ({
      organizationId: row.organizationId,
      plan: {
        id: row.planId,
        pricePerReplicaMinuteCents: row.pricePerReplicaMinuteCents,
        includedReplicaMinutes: row.includedReplicaMinutes,
      },
    }));
  }

  async getProjectUsage(organizationId: string, periodStart: Date, periodEnd: Date): Promise<ProjectUsage[]> {
    const rows = await this.db
      .select({
        projectId: projects.id,
        projectName: projects.name,
        replicaMinutes: sql<string>`coalesce(sum(${usageEvents.value}), 0)`,
      })
      .from(usageEvents)
      .innerJoin(projects, eq(projects.id, usageEvents.projectId))
      .where(
        and(
          eq(projects.organizationId, organizationId),
          isNull(projects.deletedAt),
          eq(usageEvents.metric, "replica_minutes"),
          gte(usageEvents.occurredAt, periodStart),
          lt(usageEvents.occurredAt, periodEnd),
        ),
      )
      .groupBy(projects.id, projects.name);

    return rows.map((row) => ({ ...row, replicaMinutes: Number(row.replicaMinutes) }));
  }

  async upsertDraftInvoice(input: InvoiceInput): Promise<UpsertInvoiceResult> {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: invoices.id, status: invoices.status })
        .from(invoices)
        .where(
          and(
            eq(invoices.organizationId, input.organizationId),
            eq(invoices.periodStart, input.periodStart),
            eq(invoices.periodEnd, input.periodEnd),
          ),
        );

      if (existing?.status === "finalized") {
        return { kind: "already_finalized", invoiceId: existing.id } as const;
      }

      let invoiceId: string;
      if (existing) {
        invoiceId = existing.id;
        await tx
          .update(invoices)
          .set({ planId: input.planId, totalCents: input.totalCents, updatedAt: new Date() })
          .where(eq(invoices.id, invoiceId));
        await tx.delete(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoiceId));
      } else {
        const [created] = await tx
          .insert(invoices)
          .values({
            organizationId: input.organizationId,
            planId: input.planId,
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
            totalCents: input.totalCents,
          })
          .returning({ id: invoices.id });
        invoiceId = created.id;
      }

      if (input.lineItems.length > 0) {
        await tx.insert(invoiceLineItems).values(
          input.lineItems.map((item) => ({
            invoiceId,
            projectId: item.projectId,
            description: item.description,
            replicaMinutes: item.replicaMinutes,
            amountCents: item.amountCents,
          })),
        );
      }

      return { kind: "draft", invoiceId } as const;
    });
  }
}
