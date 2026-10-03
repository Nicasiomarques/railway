import { Queue } from "bullmq";
import { Redis } from "ioredis";
import {
  CANCEL_BUILD_JOB,
  CANCEL_BUILD_JOB_RETRY,
  DEPLOYMENTS_QUEUE,
  RECONCILE_JOB,
  RECONCILE_JOB_RETRY,
  reconcileJobId,
  type CancelBuildJobData,
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
