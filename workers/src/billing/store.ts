// What the billing worker needs from Postgres. Mirrors the usage worker's UsageStore
// (usage/store.ts): the minimal read/write needed for the worker to safely do its job.

export interface BillingPlan {
  id: string;
  pricePerReplicaMinuteCents: number;
  includedReplicaMinutes: number;
}

export interface OrganizationSubscription {
  organizationId: string;
  plan: BillingPlan;
}

// One row per project that had usage in the period (architecture.md §4's usage_events, summed).
export interface ProjectUsage {
  projectId: string;
  projectName: string;
  replicaMinutes: number;
}

export interface InvoiceLineItemInput {
  projectId: string | null;
  description: string;
  replicaMinutes: number;
  amountCents: number;
}

export interface InvoiceInput {
  organizationId: string;
  planId: string;
  periodStart: Date;
  periodEnd: Date;
  totalCents: number;
  lineItems: InvoiceLineItemInput[];
}

export type UpsertInvoiceResult =
  // Line items replaced and total recomputed -- either a new invoice, or an existing draft for the
  // same period regenerated with fresher usage_events.
  | { kind: "draft"; invoiceId: string }
  // The period was already closed (status "finalized"): amounts are immutable, so nothing was
  // written. A caller that needs the new numbers must finalize a new period instead.
  | { kind: "already_finalized"; invoiceId: string };

export interface BillingStore {
  // Only organizations that have explicitly picked a plan are billed -- one with no subscription
  // row is skipped, the same way the usage worker skips an instance with no running workload.
  listActiveSubscriptions(): Promise<OrganizationSubscription[]>;

  // Usage for one organization over [periodStart, periodEnd), grouped by project -- same
  // "replica_minutes" metric and grouping as the usage API (api/src/routes/usage.ts), but scoped
  // to a single org and summed per project rather than per project+instance.
  getProjectUsage(organizationId: string, periodStart: Date, periodEnd: Date): Promise<ProjectUsage[]>;

  // Upserts the invoice for (organizationId, periodStart, periodEnd): replaces its line items and
  // total in one transaction if a draft for the period already exists, or creates a new one
  // otherwise.
  upsertDraftInvoice(input: InvoiceInput): Promise<UpsertInvoiceResult>;
}
