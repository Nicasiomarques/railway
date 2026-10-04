import type {
  BillingStore,
  InvoiceInput,
  OrganizationSubscription,
  ProjectUsage,
  UpsertInvoiceResult,
} from "./store.js";

interface StoredInvoice extends InvoiceInput {
  id: string;
  status: "draft" | "finalized";
}

// In-memory store for tests. Mirrors the Postgres contract, including upsertDraftInvoice's
// replace-in-place behavior for an existing draft and its refusal to touch a finalized invoice.
export class InMemoryBillingStore implements BillingStore {
  private readonly subscriptions = new Map<string, OrganizationSubscription>();
  private readonly usage = new Map<string, ProjectUsage[]>();
  readonly invoices: StoredInvoice[] = [];
  private nextId = 1;

  addSubscription(subscription: OrganizationSubscription): void {
    this.subscriptions.set(subscription.organizationId, subscription);
  }

  setUsage(organizationId: string, usage: ProjectUsage[]): void {
    this.usage.set(organizationId, usage);
  }

  finalize(invoiceId: string): void {
    const invoice = this.invoices.find((i) => i.id === invoiceId);
    if (invoice) invoice.status = "finalized";
  }

  async listActiveSubscriptions(): Promise<OrganizationSubscription[]> {
    return [...this.subscriptions.values()];
  }

  async getProjectUsage(organizationId: string): Promise<ProjectUsage[]> {
    return this.usage.get(organizationId) ?? [];
  }

  async upsertDraftInvoice(input: InvoiceInput): Promise<UpsertInvoiceResult> {
    const existing = this.invoices.find(
      (i) =>
        i.organizationId === input.organizationId &&
        i.periodStart.getTime() === input.periodStart.getTime() &&
        i.periodEnd.getTime() === input.periodEnd.getTime(),
    );

    if (existing?.status === "finalized") {
      return { kind: "already_finalized", invoiceId: existing.id };
    }

    if (existing) {
      existing.planId = input.planId;
      existing.totalCents = input.totalCents;
      existing.lineItems = input.lineItems;
      return { kind: "draft", invoiceId: existing.id };
    }

    const id = `invoice-${this.nextId++}`;
    this.invoices.push({ ...input, id, status: "draft" });
    return { kind: "draft", invoiceId: id };
  }
}
