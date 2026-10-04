// Contract for deployment jobs between the API (producer) and workers (consumers).
// No runtime dependencies: can be imported from any package.

export const DEPLOYMENTS_QUEUE = "deployments";
export const RECONCILE_JOB = "reconcile-instance";

export interface ReconcileJobData {
  serviceInstanceId: string;
  versionNo: number;
}

// Pending states (build in progress, replicas not yet ready) re-enqueue at a fixed interval:
// exponential backoff would let completion detection lag by several minutes.
// 240 attempts × 5s ≈ 20 min budget.
export const RECONCILE_JOB_RETRY = {
  attempts: 240,
  backoff: { type: "fixed", delay: 5000 },
  removeOnComplete: true,
  removeOnFail: 100,
} as const;

// One job per version: re-enqueuing the same version doesn't duplicate work, and a new
// version never gets stuck behind another version's active job.
export function reconcileJobId(data: ReconcileJobData): string {
  return `reconcile-${data.serviceInstanceId}-v${data.versionNo}`;
}

// Job that deletes the build Job of a cancelled deployment. Goes in the same queue; the worker picks it up by name.
export const CANCEL_BUILD_JOB = "cancel-build";

export interface CancelBuildJobData {
  deploymentId: string;
  serviceInstanceId: string;
}

export const CANCEL_BUILD_JOB_RETRY = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: true,
  removeOnFail: 100,
} as const;

// Environment provisioning saga (architecture.md §6): namespace, NetworkPolicy and quotas.
// Goes in the same queue; the worker picks it up by job name. One job per environment: re-enqueuing doesn't duplicate the saga.
export const PROVISION_ENVIRONMENT_JOB = "provision-environment";

export interface ProvisionEnvironmentJobData {
  environmentId: string;
}

export function provisionEnvironmentJobId(data: ProvisionEnvironmentJobData): string {
  return `provision-${data.environmentId}`;
}

// Steps with a transient failure (cluster API unavailable) are retried; the state of already-completed steps is preserved.
export const PROVISION_ENVIRONMENT_JOB_RETRY = {
  attempts: 10,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: true,
  removeOnFail: 100,
} as const;

// Domain/TLS (architecture.md §6 and §8): hostname → DNS → ACME certificate → edge route.
// Own queue: a domain's lifecycle has no relation to a deployment's.
export const DOMAINS_QUEUE = "domains";
export const ISSUE_CERTIFICATE_JOB = "issue-certificate";

export interface IssueCertificateJobData {
  domainId: string;
}

// One job per domain: re-enqueueing the same domain doesn't duplicate the work.
export function issueCertificateJobId(data: IssueCertificateJobData): string {
  return `issue-certificate-${data.domainId}`;
}

// Pending (DNS still propagating, ACME still validating) isn't an error: retry at a fixed interval.
// 60 attempts × 5s = 5 min budget before marking the domain as "failed".
export const ISSUE_CERTIFICATE_JOB_RETRY = {
  attempts: 60,
  backoff: { type: "fixed", delay: 5000 },
  removeOnComplete: true,
  removeOnFail: 100,
} as const;

// Volume backups (architecture.md §6: "PVC + scheduled backup (volume snapshot + logical dump)
// to object storage"). Own queue: a backup's lifecycle has no relation to a domain's or a deployment's.
export const BACKUP_QUEUE = "backups";
export const RUN_BACKUP_JOB = "run-backup";

export interface RunBackupJobData {
  volumeId: string;
}

// One job per volume per enqueue call: re-enqueuing a volume already queued doesn't duplicate the work.
export function runBackupJobId(data: RunBackupJobData): string {
  return `run-backup-${data.volumeId}`;
}

// Unlike domain issuance there's no external propagation to wait out: a backup attempt either
// completes or fails. Retries only cover a transient failure (storage momentarily unreachable),
// so the budget is short, with exponential backoff instead of a fixed interval.
export const RUN_BACKUP_JOB_RETRY = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5000 },
  removeOnComplete: true,
  removeOnFail: 100,
} as const;

// Internal "tick" job name used to wire a daily schedule to the backup queue (see
// workers/src/backup/worker.ts: scheduleDailyBackups/createBackupWorker). Not part of the
// API/worker job contract in the same sense as RUN_BACKUP_JOB: nothing produces this job today
// outside of scheduleDailyBackups itself.
export const DAILY_BACKUP_TICK_JOB = "daily-backup-tick";

// Default daily schedule for `scheduleDailyBackups`: once a day at 03:00 UTC (low-traffic window).
export const DAILY_BACKUP_CRON_DEFAULT = "0 3 * * *";

// Usage aggregator (architecture.md §3: "Usage aggregator | samples -> usage_events per
// project/service | feeds future billing"; §4: "usage_events append-only, aggregated in windows
// (1 min -> hour -> day)"). Own queue: sampling has no relation to a deployment's, a domain's or
// a volume's lifecycle.
export const USAGE_QUEUE = "usage";
export const SAMPLE_USAGE_JOB = "sample-usage";

export interface SampleUsageJobData {
  serviceInstanceId: string;
}

// One job per instance per enqueue call: re-enqueuing an instance already queued doesn't
// duplicate the sample (the jobId is scoped to the tick time, see sampleUsageJobId below).
export function sampleUsageJobId(data: SampleUsageJobData & { at?: number }): string {
  return `sample-usage-${data.serviceInstanceId}-${data.at ?? Date.now()}`;
}

// Like a backup attempt, a sample either succeeds or fails outright (no external propagation to
// wait out), so the budget is short, with exponential backoff for a transient failure (runtime API
// momentarily unreachable).
export const SAMPLE_USAGE_JOB_RETRY = {
  attempts: 3,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: true,
  removeOnFail: 100,
} as const;

// Internal "tick" job name used to wire a recurring schedule to the usage queue (see
// workers/src/usage/worker.ts: scheduleUsageSampling/createUsageWorker). Not part of the
// API/worker job contract in the same sense as SAMPLE_USAGE_JOB: nothing produces this job today
// outside of scheduleUsageSampling itself.
export const USAGE_SAMPLING_TICK_JOB = "usage-sampling-tick";

// Default sampling schedule for `scheduleUsageSampling`: every minute, matching the finest
// aggregation window in architecture.md §4 ("1 min -> hour -> day").
export const USAGE_SAMPLING_CRON_DEFAULT = "* * * * *";

// Cron services (roadmap Phase 4): each service_instances row with kind "cron" and a `schedule`
// gets one BullMQ *repeatable* job (see workers/src/cron/scheduler.ts), registered directly with
// that instance's own cron expression as `repeat.pattern` -- unlike the backup tick above, there's
// no shared fixed schedule to fan out from: every instance can run on its own cron expression.
// Goes on the same queue as deployments: firing a cron instance is implemented as "redeploy the
// instance's last known build", which the reconciler already knows how to converge on.
export const CRON_TRIGGER_JOB = "cron-trigger";

export interface CronTriggerJobData {
  serviceInstanceId: string;
}

// One repeatable registration per instance: re-registering with the same jobId updates the existing
// repeat rule instead of adding a duplicate one.
export function cronTriggerJobId(data: CronTriggerJobData): string {
  return `cron-trigger-${data.serviceInstanceId}`;
}

// A misfire isn't worth hammering: the next scheduled tick arrives soon enough on its own.
export const CRON_TRIGGER_JOB_RETRY = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5000 },
  removeOnComplete: true,
  removeOnFail: 50,
} as const;

// Environment decommissioning (TTL sweep). An environment's `ttl_at` (e.g. a PR preview marked
// for removal in api/src/routes/github.ts, or a future ephemeral CI environment) was until now
// only ever stamped, never acted on -- nothing consumed it. Own queue: tearing down an environment
// has no relation to a deployment's, a domain's or a backup's lifecycle.
export const ENVIRONMENTS_QUEUE = "environments";
export const DECOMMISSION_ENVIRONMENT_JOB = "decommission-environment";

export interface DecommissionEnvironmentJobData {
  environmentId: string;
}

// One job per environment: re-enqueuing an environment already queued for teardown doesn't duplicate the work.
export function decommissionEnvironmentJobId(data: DecommissionEnvironmentJobData): string {
  return `decommission-${data.environmentId}`;
}

// Like a backup attempt, decommissioning either completes or fails outright (no external
// propagation to wait out), so the budget is short, with exponential backoff for a transient
// failure (cluster API momentarily unreachable).
export const DECOMMISSION_ENVIRONMENT_JOB_RETRY = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5000 },
  removeOnComplete: true,
  removeOnFail: 100,
} as const;

// Internal "tick" job name used to wire a recurring sweep to the environments queue (see
// workers/src/decommission/worker.ts: scheduleEnvironmentSweep/createEnvironmentWorker). Not part
// of the API/worker job contract in the same sense as DECOMMISSION_ENVIRONMENT_JOB: nothing
// produces this job today outside of scheduleEnvironmentSweep itself.
export const ENVIRONMENT_SWEEP_TICK_JOB = "environment-sweep-tick";

// Default sweep schedule: every 5 minutes. Unlike the daily backup tick, a stale preview or
// ephemeral CI environment left running costs real cluster resources (a whole namespace, workloads
// included) for every minute past its TTL, so this stays tight.
export const ENVIRONMENT_SWEEP_CRON_DEFAULT = "*/5 * * * *";

// Outbound webhooks (roadmap.md Phase 5: "Webhooks and extensions"). Own queue: a delivery's
// lifecycle has no relation to a domain's, a deployment's or a backup's. Unlike those queues,
// there's no stable per-resource jobId here: each enqueue call is one independent delivery
// attempt of one event to one subscription, and re-enqueuing the same (subscription, event)
// pair later (e.g. another status change) must NOT be deduped against an earlier delivery.
export const WEBHOOKS_QUEUE = "webhooks";
export const DELIVER_WEBHOOK_JOB = "deliver-webhook";

export interface DeliverWebhookJobData {
  subscriptionId: string;
  event: string;
  payload: Record<string, unknown>;
}

// A flaky third-party endpoint shouldn't need a human to retry it: BullMQ owns the retry
// (attempts/backoff on the job itself), same as the other queues; deliver.ts has no retry
// logic of its own, it just throws on anything but a 2xx response.
export const DELIVER_WEBHOOK_JOB_RETRY = {
  attempts: 8,
  backoff: { type: "exponential", delay: 3000 },
  removeOnComplete: true,
  removeOnFail: 100,
} as const;

// Billing (roadmap.md Phase 4: "Billing on top of usage_events"). Own queue: closing a billing
// period has no relation to a deployment's, a domain's, a backup's or a webhook delivery's
// lifecycle. One job per (organization, period): re-enqueuing the same period is expected --
// that's how the worker is asked to regenerate an invoice -- so unlike the other per-resource
// queues, the jobId intentionally includes the period, not just the organization.
export const BILLING_QUEUE = "billing";
export const CLOSE_BILLING_PERIOD_JOB = "close-billing-period";

export interface CloseBillingPeriodJobData {
  organizationId: string;
  // ISO 8601 instants, half-open range [periodStart, periodEnd) -- same convention as the usage
  // API's from/to (api/src/routes/usage.ts).
  periodStart: string;
  periodEnd: string;
}

export function closeBillingPeriodJobId(data: CloseBillingPeriodJobData): string {
  return `close-billing-period-${data.organizationId}-${data.periodStart}`;
}

// Like a usage sample, closing a period either succeeds or fails outright against Postgres (no
// external propagation to wait out), so a short budget with exponential backoff is enough.
export const CLOSE_BILLING_PERIOD_JOB_RETRY = {
  attempts: 5,
  backoff: { type: "exponential", delay: 3000 },
  removeOnComplete: true,
  removeOnFail: 100,
} as const;
