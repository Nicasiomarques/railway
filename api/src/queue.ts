import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import {
  BACKUP_QUEUE,
  CANCEL_BUILD_JOB,
  CANCEL_BUILD_JOB_RETRY,
  DECOMMISSION_ENVIRONMENT_JOB,
  DECOMMISSION_ENVIRONMENT_JOB_RETRY,
  DELIVER_WEBHOOK_JOB,
  DELIVER_WEBHOOK_JOB_RETRY,
  DEPLOYMENTS_QUEUE,
  DOMAINS_QUEUE,
  ENVIRONMENTS_QUEUE,
  ISSUE_CERTIFICATE_JOB,
  ISSUE_CERTIFICATE_JOB_RETRY,
  RECONCILE_JOB,
  RECONCILE_JOB_RETRY,
  RUN_BACKUP_JOB,
  RUN_BACKUP_JOB_RETRY,
  WEBHOOKS_QUEUE,
  decommissionEnvironmentJobId,
  issueCertificateJobId,
  reconcileJobId,
  runBackupJobId,
  type CancelBuildJobData,
  type DecommissionEnvironmentJobData,
  type DeliverWebhookJobData,
  type IssueCertificateJobData,
  type ReconcileJobData,
  type RunBackupJobData,
} from "@railway-like/shared";
import type { Db } from "./db/client.js";
import { webhookSubscriptions } from "./db/schema.js";

// Queue production port: the API only enqueues; the workers are the consumers.
export interface DeploymentQueue {
  enqueueReconcile(data: ReconcileJobData): Promise<void>;
  enqueueCancelBuild(data: CancelBuildJobData): Promise<void>;
}

export function createDeploymentQueue(redisUrl: string): DeploymentQueue & { close(): Promise<void> } {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue(DEPLOYMENTS_QUEUE, { connection });
  return {
    async enqueueReconcile(data) {
      await queue.add(RECONCILE_JOB, data, { ...RECONCILE_JOB_RETRY, jobId: reconcileJobId(data) });
    },
    async enqueueCancelBuild(data) {
      // One cancellation per deployment: retrying doesn't create a second one.
      await queue.add(CANCEL_BUILD_JOB, data, { ...CANCEL_BUILD_JOB_RETRY, jobId: `cancel-build-${data.deploymentId}` });
    },
    async close() {
      await queue.close();
      await connection.quit();
    },
  };
}

// Production port for the domain/TLS queue (architecture.md §6 and §8). Own queue: a domain's
// lifecycle doesn't share jobs with a deployment's.
export interface DomainQueue {
  enqueueIssueCertificate(data: IssueCertificateJobData): Promise<void>;
}

export function createDomainQueue(redisUrl: string): DomainQueue & { close(): Promise<void> } {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue(DOMAINS_QUEUE, { connection });
  return {
    async enqueueIssueCertificate(data) {
      // One job per domain: re-enqueueing the same domain doesn't duplicate the work.
      await queue.add(ISSUE_CERTIFICATE_JOB, data, { ...ISSUE_CERTIFICATE_JOB_RETRY, jobId: issueCertificateJobId(data) });
    },
    async close() {
      await queue.close();
      await connection.quit();
    },
  };
}

// Production port for the backup queue (architecture.md §6). Own queue: a volume's backup
// lifecycle doesn't share jobs with a domain's or a deployment's.
export interface BackupQueue {
  enqueueRunBackup(data: RunBackupJobData): Promise<void>;
}

export function createBackupQueue(redisUrl: string): BackupQueue & { close(): Promise<void> } {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue(BACKUP_QUEUE, { connection });
  return {
    async enqueueRunBackup(data) {
      // One job per volume: re-enqueueing a backup already queued doesn't duplicate the work.
      await queue.add(RUN_BACKUP_JOB, data, { ...RUN_BACKUP_JOB_RETRY, jobId: runBackupJobId(data) });
    },
    async close() {
      await queue.close();
      await connection.quit();
    },
  };
}

// Production port for the environments queue (roadmap.md Phase 5: ephemeral CI environments).
// Own queue: shared with the TTL sweep's periodic tick (workers/src/decommission/worker.ts), but
// unrelated to a deployment's, a domain's or a backup's lifecycle. The API only ever enqueues an
// immediate decommission (explicit teardown, e.g. the CI job finished); the sweep's own tick is
// registered by the worker process, not here.
export interface EnvironmentQueue {
  enqueueDecommission(data: DecommissionEnvironmentJobData): Promise<void>;
}

export function createEnvironmentQueue(redisUrl: string): EnvironmentQueue & { close(): Promise<void> } {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue<DecommissionEnvironmentJobData>(ENVIRONMENTS_QUEUE, { connection });
  return {
    async enqueueDecommission(data) {
      // One job per environment: re-enqueuing an environment already queued for teardown doesn't duplicate the work.
      await queue.add(DECOMMISSION_ENVIRONMENT_JOB, data, {
        ...DECOMMISSION_ENVIRONMENT_JOB_RETRY,
        jobId: decommissionEnvironmentJobId(data),
      });
    },
    async close() {
      await queue.close();
      await connection.quit();
    },
  };
}

// Production port for the outbound webhooks queue (roadmap.md Phase 5). Unlike the other queues
// here, enqueuing isn't "one job for one known id" — it's "resolve which subscriptions care about
// this event, then enqueue one delivery per match" — so this port needs `db`, not just Redis.
export interface WebhookQueue {
  enqueueWebhookDeliveries(
    organizationId: string,
    projectId: string | null,
    event: string,
    payload: Record<string, unknown>,
  ): Promise<void>;
}

export function createWebhookQueue(db: Db, redisUrl: string): WebhookQueue & { close(): Promise<void> } {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue<DeliverWebhookJobData>(WEBHOOKS_QUEUE, { connection });
  return {
    async enqueueWebhookDeliveries(organizationId, projectId, event, payload) {
      // Matches subscriptions for the whole organization (projectId is null) OR this specific
      // project, active, and that asked for this event type.
      const matches = await db
        .select({ id: webhookSubscriptions.id })
        .from(webhookSubscriptions)
        .where(
          and(
            eq(webhookSubscriptions.organizationId, organizationId),
            eq(webhookSubscriptions.isActive, true),
            projectId
              ? or(isNull(webhookSubscriptions.projectId), eq(webhookSubscriptions.projectId, projectId))
              : isNull(webhookSubscriptions.projectId),
            sql`${webhookSubscriptions.events} @> ARRAY[${event}]::text[]`,
          ),
        );

      // One delivery job per matching subscription. No shared jobId: each delivery is independent,
      // and BullMQ's own attempts/backoff (DELIVER_WEBHOOK_JOB_RETRY) own the retry for each one.
      for (const sub of matches) {
        await queue.add(DELIVER_WEBHOOK_JOB, { subscriptionId: sub.id, event, payload }, DELIVER_WEBHOOK_JOB_RETRY);
      }
    },
    async close() {
      await queue.close();
      await connection.quit();
    },
  };
}
