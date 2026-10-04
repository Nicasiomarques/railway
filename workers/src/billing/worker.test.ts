import type { Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import type { CloseBillingPeriodJobData } from "@railway-like/shared";
import { InMemoryBillingStore } from "./in-memory-store.js";
import { enqueueCloseBillingPeriodForAllOrganizations, handleCloseBillingPeriodJob } from "./worker.js";

const ORG_ID = "org-1";
const PERIOD = { periodStart: "2026-01-01T00:00:00.000Z", periodEnd: "2026-02-01T00:00:00.000Z" };

function setup() {
  const store = new InMemoryBillingStore();
  return { store, deps: { store } };
}

describe("handleCloseBillingPeriodJob", () => {
  it("an organization with no subscription returns not_subscribed and writes nothing", async () => {
    const { deps, store } = setup();

    const result = await handleCloseBillingPeriodJob(deps, { organizationId: ORG_ID, ...PERIOD });

    expect(result).toEqual({ kind: "not_subscribed" });
    expect(store.invoices).toHaveLength(0);
  });

  it("bills usage above the plan's included minutes, per project", async () => {
    const { deps, store } = setup();
    store.addSubscription({ organizationId: ORG_ID, plan: { id: "plan-pro", pricePerReplicaMinuteCents: 1, includedReplicaMinutes: 1000 } });
    store.setUsage(ORG_ID, [
      { projectId: "proj-a", projectName: "Web", replicaMinutes: 1500 },
      { projectId: "proj-b", projectName: "Worker", replicaMinutes: 200 },
    ]);

    const result = await handleCloseBillingPeriodJob(deps, { organizationId: ORG_ID, ...PERIOD });

    // 1700 total minutes, 1000 included: proj-a consumes the full allowance (1000 of its 1500),
    // billing 500; proj-b gets none of the (now exhausted) allowance, billing all 200.
    expect(result).toEqual({ kind: "closed", invoiceId: "invoice-1", totalCents: 700 });
    expect(store.invoices[0].lineItems).toEqual([
      { projectId: "proj-a", description: "Web - replica-minutes", replicaMinutes: 1500, amountCents: 500 },
      { projectId: "proj-b", description: "Worker - replica-minutes", replicaMinutes: 200, amountCents: 200 },
    ]);
  });

  it("usage entirely within the included allowance bills nothing", async () => {
    const { deps, store } = setup();
    store.addSubscription({ organizationId: ORG_ID, plan: { id: "plan-pro", pricePerReplicaMinuteCents: 1, includedReplicaMinutes: 1000 } });
    store.setUsage(ORG_ID, [{ projectId: "proj-a", projectName: "Web", replicaMinutes: 500 }]);

    const result = await handleCloseBillingPeriodJob(deps, { organizationId: ORG_ID, ...PERIOD });

    expect(result).toEqual({ kind: "closed", invoiceId: "invoice-1", totalCents: 0 });
  });

  it("re-running for the same period replaces the draft's line items instead of duplicating them", async () => {
    const { deps, store } = setup();
    store.addSubscription({ organizationId: ORG_ID, plan: { id: "plan-pro", pricePerReplicaMinuteCents: 1, includedReplicaMinutes: 0 } });
    store.setUsage(ORG_ID, [{ projectId: "proj-a", projectName: "Web", replicaMinutes: 100 }]);
    const first = await handleCloseBillingPeriodJob(deps, { organizationId: ORG_ID, ...PERIOD });

    store.setUsage(ORG_ID, [{ projectId: "proj-a", projectName: "Web", replicaMinutes: 300 }]);
    const second = await handleCloseBillingPeriodJob(deps, { organizationId: ORG_ID, ...PERIOD });

    expect(store.invoices).toHaveLength(1);
    expect(first.kind === "closed" && first.invoiceId).toBe(second.kind === "closed" && second.invoiceId);
    expect(second).toEqual({ kind: "closed", invoiceId: "invoice-1", totalCents: 300 });
  });

  it("a finalized invoice is left untouched", async () => {
    const { deps, store } = setup();
    store.addSubscription({ organizationId: ORG_ID, plan: { id: "plan-pro", pricePerReplicaMinuteCents: 1, includedReplicaMinutes: 0 } });
    store.setUsage(ORG_ID, [{ projectId: "proj-a", projectName: "Web", replicaMinutes: 100 }]);
    const first = await handleCloseBillingPeriodJob(deps, { organizationId: ORG_ID, ...PERIOD });
    expect(first.kind).toBe("closed");
    store.finalize((first as { invoiceId: string }).invoiceId);

    store.setUsage(ORG_ID, [{ projectId: "proj-a", projectName: "Web", replicaMinutes: 999 }]);
    const second = await handleCloseBillingPeriodJob(deps, { organizationId: ORG_ID, ...PERIOD });

    expect(second).toEqual({ kind: "already_finalized", invoiceId: "invoice-1" });
    expect(store.invoices[0].lineItems[0].replicaMinutes).toBe(100);
  });
});

describe("enqueueCloseBillingPeriodForAllOrganizations", () => {
  it("fans out one close-billing-period job per organization id", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const fakeQueue = { add } as unknown as Queue<CloseBillingPeriodJobData>;

    await enqueueCloseBillingPeriodForAllOrganizations(fakeQueue, ["org-a", "org-b"], PERIOD);

    expect(add).toHaveBeenCalledTimes(2);
    expect(add.mock.calls[0][1]).toEqual({ organizationId: "org-a", ...PERIOD });
    expect(add.mock.calls[1][1]).toEqual({ organizationId: "org-b", ...PERIOD });
  });
});
