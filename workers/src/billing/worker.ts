import { Queue, Worker, type ConnectionOptions, type JobsOptions } from "bullmq";
import {
  BILLING_QUEUE,
  CLOSE_BILLING_PERIOD_JOB,
  CLOSE_BILLING_PERIOD_JOB_RETRY,
  closeBillingPeriodJobId,
  type CloseBillingPeriodJobData,
} from "@railway-like/shared";
import type { BillingStore } from "./store.js";

export { BILLING_QUEUE, CLOSE_BILLING_PERIOD_JOB, type CloseBillingPeriodJobData };

export const CLOSE_BILLING_PERIOD_JOB_OPTIONS: JobsOptions = CLOSE_BILLING_PERIOD_JOB_RETRY;

export async function enqueueCloseBillingPeriod(
  queue: Queue<CloseBillingPeriodJobData>,
  data: CloseBillingPeriodJobData,
): Promise<void> {
  await queue.add(CLOSE_BILLING_PERIOD_JOB, data, { ...CLOSE_BILLING_PERIOD_JOB_OPTIONS, jobId: closeBillingPeriodJobId(data) });
}

// Fans a period out into one close-billing-period job per subscribed organization -- the producer
// side a monthly schedule would call (mirrors enqueueUsageSamplingTick in usage/worker.ts).
export async function enqueueCloseBillingPeriodForAllOrganizations(
  queue: Queue<CloseBillingPeriodJobData>,
  organizationIds: string[],
  period: { periodStart: string; periodEnd: string },
): Promise<void> {
  for (const organizationId of organizationIds) {
    await enqueueCloseBillingPeriod(queue, { organizationId, ...period });
  }
}

export interface BillingWorkerDeps {
  store: BillingStore;
}

export type CloseBillingPeriodResult =
  | { kind: "closed"; invoiceId: string; totalCents: number }
  | { kind: "already_finalized"; invoiceId: string }
  | { kind: "not_subscribed" };

// Closes one organization's billing period: sums its usage_events per project (via the store,
// scoped to [periodStart, periodEnd)), prices it against the org's plan, and writes the result as
// a draft invoice. Safe to re-run for the same period before it's finalized -- each run replaces
// the previous draft's line items with fresher numbers, the same way a redeploy supersedes a
// previous deployment rather than piling up.
export async function handleCloseBillingPeriodJob(
  deps: BillingWorkerDeps,
  data: CloseBillingPeriodJobData,
): Promise<CloseBillingPeriodResult> {
  const subscriptions = await deps.store.listActiveSubscriptions();
  const subscription = subscriptions.find((s) => s.organizationId === data.organizationId);
  if (!subscription) return { kind: "not_subscribed" };

  const periodStart = new Date(data.periodStart);
  const periodEnd = new Date(data.periodEnd);
  const projectUsage = await deps.store.getProjectUsage(data.organizationId, periodStart, periodEnd);

  // The plan's included minutes are a pool shared across the whole organization, not per project
  // (architecture.md usage_events are already project-scoped, but pricing tiers apply org-wide):
  // consume the allowance against total usage first, then bill only the remainder, spread across
  // line items in the same order getProjectUsage returned them.
  let remainingIncluded = subscription.plan.includedReplicaMinutes;
  let totalCents = 0;
  const lineItems = projectUsage.map((usage) => {
    const includedHere = Math.min(remainingIncluded, usage.replicaMinutes);
    remainingIncluded -= includedHere;
    const billableMinutes = usage.replicaMinutes - includedHere;
    const amountCents = billableMinutes * subscription.plan.pricePerReplicaMinuteCents;
    totalCents += amountCents;
    return {
      projectId: usage.projectId,
      description: `${usage.projectName} - replica-minutes`,
      replicaMinutes: usage.replicaMinutes,
      amountCents,
    };
  });

  const result = await deps.store.upsertDraftInvoice({
    organizationId: data.organizationId,
    planId: subscription.plan.id,
    periodStart,
    periodEnd,
    totalCents,
    lineItems,
  });

  if (result.kind === "already_finalized") return result;
  return { kind: "closed", invoiceId: result.invoiceId, totalCents };
}

export function createBillingWorker(connection: ConnectionOptions, deps: BillingWorkerDeps): Worker {
  return new Worker(
    BILLING_QUEUE,
    async (job) => handleCloseBillingPeriodJob(deps, job.data as CloseBillingPeriodJobData),
    { connection },
  );
}
