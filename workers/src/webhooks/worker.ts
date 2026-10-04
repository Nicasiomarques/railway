import { Queue, Worker, type ConnectionOptions, type JobsOptions } from "bullmq";
import { WEBHOOKS_QUEUE, DELIVER_WEBHOOK_JOB, DELIVER_WEBHOOK_JOB_RETRY, type DeliverWebhookJobData } from "@railway-like/shared";
import { FetchWebhookTransport, type WebhookTransport } from "./adapter.js";
import type { WebhookDeliveryStore } from "./store.js";
import { deliverWebhook } from "./deliver.js";

// Constants and contract come from @railway-like/shared: the API produces jobs with the same rules.
export { WEBHOOKS_QUEUE, DELIVER_WEBHOOK_JOB, type DeliverWebhookJobData };

export const DELIVER_WEBHOOK_JOB_OPTIONS: JobsOptions = DELIVER_WEBHOOK_JOB_RETRY;

// Producer-side convenience, mirrors enqueueIssueCertificate (domain/worker.ts) and enqueueRunBackup
// (backup/worker.ts): adds one job without touching the database. The API's queue.ts (createWebhookQueue)
// does the subscription matching and calls the equivalent of this directly, since it already has `db`.
export async function enqueueDeliverWebhook(queue: Queue<DeliverWebhookJobData>, data: DeliverWebhookJobData): Promise<void> {
  await queue.add(DELIVER_WEBHOOK_JOB, data, DELIVER_WEBHOOK_JOB_OPTIONS);
}

export interface WebhookWorkerDeps {
  store: WebhookDeliveryStore;
  transport?: WebhookTransport;
}

export type HandleDeliverWebhookResult =
  | { kind: "delivered"; status: number }
  | { kind: "skipped"; reason: "not_found" | "inactive" };

// Looks up the subscription and delivers, if it's still active. BullMQ owns retries (attempts/backoff
// configured on the job, see DELIVER_WEBHOOK_JOB_RETRY): a failed delivery throws here and is never
// swallowed, so the job is retried according to that budget.
export async function handleDeliverWebhookJob(
  deps: WebhookWorkerDeps,
  data: DeliverWebhookJobData,
  attempt: number,
): Promise<HandleDeliverWebhookResult> {
  const subscription = await deps.store.getSubscription(data.subscriptionId);
  if (!subscription) return { kind: "skipped", reason: "not_found" };
  if (!subscription.isActive) return { kind: "skipped", reason: "inactive" };

  const transport = deps.transport ?? new FetchWebhookTransport();
  const result = await deliverWebhook({ transport, store: deps.store }, subscription, data.event, data.payload, attempt);
  return { kind: "delivered", status: result.status as number };
}

export function createWebhookWorker(connection: ConnectionOptions, deps: WebhookWorkerDeps): Worker<DeliverWebhookJobData> {
  return new Worker<DeliverWebhookJobData>(
    WEBHOOKS_QUEUE,
    (job) => handleDeliverWebhookJob(deps, job.data, job.attemptsMade + 1),
    { connection },
  );
}
