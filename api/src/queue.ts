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

// Porta de produção da fila: a API só enfileira; quem consome são os workers.
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
      // Um cancelamento por deployment: repetir não cria dois.
      await queue.add(CANCEL_BUILD_JOB, data, { ...CANCEL_BUILD_JOB_RETRY, jobId: `cancel-build-${data.deploymentId}` });
    },
    async close() {
      await queue.close();
      await connection.quit();
    },
  };
}

// Porta de produção da fila de domínio/TLS (architecture.md §6 e §8). Fila própria: o ciclo de vida
// de um domínio não compartilha jobs com o de um deployment.
export interface DomainQueue {
  enqueueIssueCertificate(data: IssueCertificateJobData): Promise<void>;
}

export function createDomainQueue(redisUrl: string): DomainQueue & { close(): Promise<void> } {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue(DOMAINS_QUEUE, { connection });
  return {
    async enqueueIssueCertificate(data) {
      // Um job por domínio: reenfileirar o mesmo domínio não duplica o trabalho.
      await queue.add(ISSUE_CERTIFICATE_JOB, data, { ...ISSUE_CERTIFICATE_JOB_RETRY, jobId: issueCertificateJobId(data) });
    },
    async close() {
      await queue.close();
      await connection.quit();
    },
  };
}
