import { Queue, Worker, type ConnectionOptions, type JobsOptions } from "bullmq";
import {
  CANCEL_BUILD_JOB,
  DEPLOYMENTS_QUEUE,
  PROVISION_ENVIRONMENT_JOB,
  PROVISION_ENVIRONMENT_JOB_RETRY,
  RECONCILE_JOB,
  RECONCILE_JOB_RETRY,
  provisionEnvironmentJobId,
  reconcileJobId,
  type CancelBuildJobData,
  type ProvisionEnvironmentJobData,
  type ReconcileJobData,
} from "@railway-like/shared";
import { handleReconcileJob, type ReconcilerDeps } from "./reconcile.js";
import { handleCancelBuildJob } from "../build/cancel.js";
import { handleProvisionEnvironmentJob, type ProvisioningDeps } from "../provisioning/saga.js";

// Constantes e contrato vêm de @railway-like/shared: a API produz os jobs com as mesmas regras.
export { DEPLOYMENTS_QUEUE, RECONCILE_JOB, type ReconcileJobData };

export const RECONCILE_JOB_OPTIONS: JobsOptions = RECONCILE_JOB_RETRY;

export async function enqueueReconcile(queue: Queue<ReconcileJobData>, data: ReconcileJobData): Promise<void> {
  await queue.add(RECONCILE_JOB, data, { ...RECONCILE_JOB_OPTIONS, jobId: reconcileJobId(data) });
}

export async function enqueueProvisionEnvironment(
  queue: Queue<ProvisionEnvironmentJobData>,
  data: ProvisionEnvironmentJobData,
): Promise<void> {
  await queue.add(PROVISION_ENVIRONMENT_JOB, data, { ...PROVISION_ENVIRONMENT_JOB_RETRY, jobId: provisionEnvironmentJobId(data) });
}

export interface WorkerDeps extends ReconcilerDeps {
  // Saga de provisionamento de ambiente. Sem ela, jobs de provisionamento falham de forma explícita.
  provisioning?: ProvisioningDeps;
}

// Uma fila, três tipos de job: reconciliação (converge o runtime), cancelamento de build e provisionamento de ambiente.
export function createReconcileWorker(connection: ConnectionOptions, deps: WorkerDeps): Worker<DeploymentJobData> {
  return new Worker<DeploymentJobData>(
    DEPLOYMENTS_QUEUE,
    async (job) => {
      if (job.name === CANCEL_BUILD_JOB) return handleCancelBuildJob(deps, job.data as CancelBuildJobData);
      if (job.name === PROVISION_ENVIRONMENT_JOB) {
        if (!deps.provisioning) throw new Error("provisionamento de ambiente sem store/runtime configurados");
        return handleProvisionEnvironmentJob(deps.provisioning, job.data as ProvisionEnvironmentJobData, {
          attemptsMade: job.attemptsMade,
          maxAttempts: job.opts.attempts ?? 1,
        });
      }
      return handleReconcileJob(deps, job.data as ReconcileJobData, {
        attemptsMade: job.attemptsMade,
        maxAttempts: job.opts.attempts ?? 1,
      });
    },
    { connection },
  );
}

type DeploymentJobData = ReconcileJobData | CancelBuildJobData | ProvisionEnvironmentJobData;
