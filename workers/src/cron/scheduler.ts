import { Queue, type JobsOptions } from "bullmq";
import { CRON_TRIGGER_JOB, CRON_TRIGGER_JOB_RETRY, cronTriggerJobId, type CronTriggerJobData } from "@railway-like/shared";
import type { CronInstance } from "./store.js";

// Constants and contract come from @railway-like/shared: whatever else ever produces this job
// (today, only this module) follows the same rules.
export { CRON_TRIGGER_JOB, type CronTriggerJobData };

export const CRON_TRIGGER_JOB_OPTIONS: JobsOptions = CRON_TRIGGER_JOB_RETRY;

// Registers one BullMQ *repeatable* job per cron instance, using that instance's own cron
// expression as `repeat.pattern` -- BullMQ's own scheduler fires it on that schedule, no external
// cron process required (same mechanism as workers/src/backup/worker.ts's scheduleDailyBackups,
// but one schedule per instance instead of one shared daily tick, since each cron service can run
// on its own expression).
//
// `jobId` is per instance (cronTriggerJobId), so calling this again at the next worker boot -- or
// after a schedule edit -- replaces the existing repeat rule for that instance instead of adding a
// duplicate one. It does NOT remove the repeatable job for an instance that no longer appears in
// `instances` (deleted, or no longer kind "cron"); doing that requires `queue.removeRepeatableByKey`
// with a key this function doesn't currently track, left as a known gap -- see the note in
// workers/src/cron/worker.ts about this module's scope.
export async function registerCronSchedules(queue: Queue<CronTriggerJobData>, instances: CronInstance[]): Promise<void> {
  for (const instance of instances) {
    await queue.add(
      CRON_TRIGGER_JOB,
      { serviceInstanceId: instance.serviceInstanceId },
      {
        ...CRON_TRIGGER_JOB_OPTIONS,
        jobId: cronTriggerJobId({ serviceInstanceId: instance.serviceInstanceId }),
        repeat: { pattern: instance.schedule },
      },
    );
  }
}
