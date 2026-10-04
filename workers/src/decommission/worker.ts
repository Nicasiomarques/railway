import { Queue, Worker, type ConnectionOptions, type JobsOptions } from "bullmq";
import {
  DECOMMISSION_ENVIRONMENT_JOB,
  DECOMMISSION_ENVIRONMENT_JOB_RETRY,
  decommissionEnvironmentJobId,
  ENVIRONMENT_SWEEP_CRON_DEFAULT,
  ENVIRONMENT_SWEEP_TICK_JOB,
  ENVIRONMENTS_QUEUE,
  type DecommissionEnvironmentJobData,
} from "@railway-like/shared";
import { decommissionEnvironment, type DecommissionDeps } from "./saga.js";

// Constants and contract come from @railway-like/shared: whatever else ever produces this job follows the same rules.
export { ENVIRONMENTS_QUEUE, DECOMMISSION_ENVIRONMENT_JOB, type DecommissionEnvironmentJobData };

export const DECOMMISSION_ENVIRONMENT_JOB_OPTIONS: JobsOptions = DECOMMISSION_ENVIRONMENT_JOB_RETRY;

export async function enqueueDecommission(
  queue: Queue<DecommissionEnvironmentJobData>,
  data: DecommissionEnvironmentJobData,
): Promise<void> {
  await queue.add(DECOMMISSION_ENVIRONMENT_JOB, data, {
    ...DECOMMISSION_ENVIRONMENT_JOB_OPTIONS,
    jobId: decommissionEnvironmentJobId(data),
  });
}

export interface EnvironmentWorkerDeps extends DecommissionDeps {
  // Producer side of this same queue: the periodic sweep tick (see scheduleEnvironmentSweep below)
  // re-enqueues one decommission job per expired environment it finds.
  queue?: Queue<DecommissionEnvironmentJobData>;
}

export type SweepResult = { kind: "skipped" } | { kind: "scheduled"; count: number };

// Finds every expired environment and re-enqueues one decommission job per environment. Without
// `queue` wired, this is a no-op rather than a crash (mirrors workers/src/backup/worker.ts's
// DAILY_BACKUP_TICK_JOB handling), so a tick job can arrive safely even in a setup that hasn't
// called scheduleEnvironmentSweep.
export async function sweepExpiredEnvironments(deps: EnvironmentWorkerDeps): Promise<SweepResult> {
  if (!deps.queue) return { kind: "skipped" };
  const expired = await deps.store.listExpired(new Date());
  for (const env of expired) {
    await enqueueDecommission(deps.queue, { environmentId: env.id });
  }
  return { kind: "scheduled", count: expired.length };
}

export function createEnvironmentWorker(connection: ConnectionOptions, deps: EnvironmentWorkerDeps): Worker {
  return new Worker(
    ENVIRONMENTS_QUEUE,
    async (job) => {
      if (job.name === ENVIRONMENT_SWEEP_TICK_JOB) return sweepExpiredEnvironments(deps);
      return decommissionEnvironment(deps, job.data as DecommissionEnvironmentJobData);
    },
    { connection },
  );
}

// Registers the periodic sweep (BullMQ *repeatable* job -- BullMQ's own scheduler fires it, no
// external cron process required; same mechanism as workers/src/backup/worker.ts's
// scheduleDailyBackups and workers/src/usage/worker.ts's scheduleUsageSampling). Unlike those two,
// this one IS wired in production (workers/src/index.ts): a preview or ephemeral CI environment
// left running past its TTL costs real cluster resources every tick it's missed, so the sweep
// can't be left as an opt-in for later.
//
// `jobId` is fixed (ENVIRONMENT_SWEEP_TICK_JOB), so calling this again at the next worker boot
// replaces the existing repeat rule instead of adding a duplicate one.
export async function scheduleEnvironmentSweep(
  queue: Queue<DecommissionEnvironmentJobData>,
  opts: { cronPattern?: string } = {},
): Promise<void> {
  await queue.add(
    ENVIRONMENT_SWEEP_TICK_JOB,
    // The tick job carries no payload; `queue` is typed for DecommissionEnvironmentJobData because
    // that's the job it's otherwise used for, so an empty object is cast rather than widening that type.
    {} as DecommissionEnvironmentJobData,
    {
      jobId: ENVIRONMENT_SWEEP_TICK_JOB,
      repeat: { pattern: opts.cronPattern ?? ENVIRONMENT_SWEEP_CRON_DEFAULT },
      removeOnComplete: true,
      removeOnFail: 100,
    },
  );
}
