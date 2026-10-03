import { Queue } from "bullmq";
import { Redis } from "ioredis";
import {
  CANCEL_BUILD_JOB,
  CANCEL_BUILD_JOB_RETRY,
  DEPLOYMENTS_QUEUE,
  DOMAINS_QUEUE,
  ISSUE_CERTIFICATE_JOB,
  ISSUE_CERTIFICATE_JOB_RETRY,
  RECONCILE_JOB,
  RECONCILE_JOB_RETRY,
  issueCertificateJobId,
  reconcileJobId,
  type CancelBuildJobData,
  type IssueCertificateJobData,
  type ReconcileJobData,
} from "@railway-like/shared";

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
