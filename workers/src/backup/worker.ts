import { Queue, Worker, type ConnectionOptions, type JobsOptions } from "bullmq";
import {
  BACKUP_QUEUE,
  DAILY_BACKUP_CRON_DEFAULT,
  DAILY_BACKUP_TICK_JOB,
  RESTORE_BACKUP_JOB,
  RESTORE_BACKUP_JOB_RETRY,
  RUN_BACKUP_JOB,
  RUN_BACKUP_JOB_RETRY,
  restoreBackupJobId,
  runBackupJobId,
  type RestoreBackupJobData,
  type RunBackupJobData,
} from "@railway-like/shared";
import type { BackupProvider } from "./adapter.js";
import type { BackupStore } from "./store.js";

// Constants and contract come from @railway-like/shared: the API produces jobs with the same rules.
export { BACKUP_QUEUE, RUN_BACKUP_JOB, RESTORE_BACKUP_JOB, type RunBackupJobData, type RestoreBackupJobData };

export const RUN_BACKUP_JOB_OPTIONS: JobsOptions = RUN_BACKUP_JOB_RETRY;
export const RESTORE_BACKUP_JOB_OPTIONS: JobsOptions = RESTORE_BACKUP_JOB_RETRY;

export async function enqueueRunBackup(queue: Queue<RunBackupJobData>, data: RunBackupJobData): Promise<void> {
  await queue.add(RUN_BACKUP_JOB, data, { ...RUN_BACKUP_JOB_OPTIONS, jobId: runBackupJobId(data) });
}

export async function enqueueRestoreBackup(queue: Queue<RestoreBackupJobData>, data: RestoreBackupJobData): Promise<void> {
  await queue.add(RESTORE_BACKUP_JOB, data, { ...RESTORE_BACKUP_JOB_OPTIONS, jobId: restoreBackupJobId(data) });
}

// Enqueues one run-backup job per volume. This is the function a daily schedule ultimately calls
// (directly, or through the `daily-backup-tick` job handled below); see `scheduleDailyBackups` for
// how this workstream expects that schedule to be wired to a real cron.
export async function enqueueDailyBackup(queue: Queue<RunBackupJobData>, volumeIds: string[]): Promise<void> {
  for (const volumeId of volumeIds) {
    await enqueueRunBackup(queue, { volumeId });
  }
}

export interface BackupWorkerDeps {
  store: BackupStore;
  provider: BackupProvider;
  // Only used to process the daily `daily-backup-tick` job (see `scheduleDailyBackups` below).
  // workers/src/index.ts registers this worker without them today, since there's no production
  // schedule yet — a tick job simply never arrives, and the worker ignores it if one does.
  queue?: Queue<RunBackupJobData>;
  listVolumeIds?: () => Promise<string[]>;
}

export type ProcessBackupResult =
  | { kind: "completed" }
  | { kind: "failed"; reason: string }
  | { kind: "not_found" };

// Runs one backup attempt for the volume (architecture.md §6). Marks the volume "pending" for the
// duration of the attempt; the caller (handleRunBackupJob) decides whether a failure is transient
// (worth retrying) or final.
export async function processBackup(deps: BackupWorkerDeps, volumeId: string): Promise<ProcessBackupResult> {
  const volume = await deps.store.get(volumeId);
  if (!volume) return { kind: "not_found" };

  await deps.store.setBackupState(volume.id, volume.backupState, "pending");
  const result = await deps.provider.runBackup(volumeId);
  if (result.status === "completed") {
    await deps.store.setBackupState(volume.id, "pending", "completed", new Date());
    return { kind: "completed" };
  }
  return { kind: "failed", reason: result.reason ?? "backup failed" };
}

// Decides what to do with a job: a failed attempt retries until the budget runs out; on the last
// retry, the volume goes to "failed" with the reason. `budget` comes from BullMQ, keeping the
// budget on the queue (same pattern as the domain worker's handleIssueCertificateJob).
export async function handleRunBackupJob(
  deps: BackupWorkerDeps,
  data: RunBackupJobData,
  budget: { attemptsMade: number; maxAttempts: number },
): Promise<ProcessBackupResult> {
  const result = await processBackup(deps, data.volumeId);
  if (result.kind !== "failed") return result;

  const lastAttempt = budget.attemptsMade + 1 >= budget.maxAttempts;
  if (!lastAttempt) {
    throw new Error(`${result.reason} (attempt ${budget.attemptsMade + 1} of ${budget.maxAttempts})`);
  }
  await deps.store.setBackupState(data.volumeId, "pending", "failed");
  return { kind: "failed", reason: `backup did not complete after ${budget.maxAttempts} attempts: ${result.reason}` };
}

// Mirrors processBackup: marks the volume "pending" for the duration of the restore attempt, then
// "completed" or leaves it to the caller to mark "failed" on the last retry (same split as
// processBackup/handleRunBackupJob, so a restore shows up in the same backupState the UI already
// renders — there's no separate "restoring" state to add).
export async function processRestore(deps: BackupWorkerDeps, volumeId: string): Promise<ProcessBackupResult> {
  const volume = await deps.store.get(volumeId);
  if (!volume) return { kind: "not_found" };

  await deps.store.setBackupState(volume.id, volume.backupState, "pending");
  const result = await deps.provider.restoreBackup(volumeId);
  if (result.status === "completed") {
    await deps.store.setBackupState(volume.id, "pending", "completed", new Date());
    return { kind: "completed" };
  }
  return { kind: "failed", reason: result.reason ?? "restore failed" };
}

export async function handleRestoreBackupJob(
  deps: BackupWorkerDeps,
  data: RestoreBackupJobData,
  budget: { attemptsMade: number; maxAttempts: number },
): Promise<ProcessBackupResult> {
  const result = await processRestore(deps, data.volumeId);
  if (result.kind !== "failed") return result;

  const lastAttempt = budget.attemptsMade + 1 >= budget.maxAttempts;
  if (!lastAttempt) {
    throw new Error(`${result.reason} (attempt ${budget.attemptsMade + 1} of ${budget.maxAttempts})`);
  }
  await deps.store.setBackupState(data.volumeId, "pending", "failed");
  return { kind: "failed", reason: `restore did not complete after ${budget.maxAttempts} attempts: ${result.reason}` };
}

export function createBackupWorker(connection: ConnectionOptions, deps: BackupWorkerDeps): Worker {
  return new Worker(
    BACKUP_QUEUE,
    async (job) => {
      if (job.name === DAILY_BACKUP_TICK_JOB) {
        // Nothing wires queue/listVolumeIds in production yet (see scheduleDailyBackups below);
        // a tick job that arrives without them configured is a no-op rather than a crash.
        if (!deps.queue || !deps.listVolumeIds) return { kind: "skipped" as const };
        await enqueueDailyBackup(deps.queue, await deps.listVolumeIds());
        return { kind: "scheduled" as const };
      }
      if (job.name === RESTORE_BACKUP_JOB) {
        return handleRestoreBackupJob(deps, job.data as RestoreBackupJobData, {
          attemptsMade: job.attemptsMade,
          maxAttempts: job.opts.attempts ?? 1,
        });
      }
      return handleRunBackupJob(deps, job.data as RunBackupJobData, {
        attemptsMade: job.attemptsMade,
        maxAttempts: job.opts.attempts ?? 1,
      });
    },
    { connection },
  );
}

// --- Daily scheduling ----------------------------------------------------------------------
//
// architecture.md §6 asks for volumes to get "PVC + scheduled backup ... to object storage" once
// a day. This workstream provides the mechanism (the `daily-backup-tick` job name, the
// enqueueDailyBackup fan-out, and the branch in createBackupWorker above that answers a tick), but
// deliberately does NOT wire a real production cron: there's no live list of volumes to schedule
// yet, and workers/src/index.ts registers createBackupWorker with just { store, provider }, as
// shown in this file's own createBackupWorker signature.
//
// To connect this to a real daily cron later, call `scheduleDailyBackups` once at worker start-up
// (it registers a BullMQ *repeatable* job — BullMQ's own scheduler fires it, no external cron
// process required) and pass `queue`/`listVolumeIds` into `createBackupWorker`'s deps so the tick
// is actually acted on:
//
//   const backupQueue = new Queue<RunBackupJobData>(BACKUP_QUEUE, { connection });
//   await scheduleDailyBackups(backupQueue);
//   const backupWorker = createBackupWorker(connection, {
//     store: new PostgresBackupStore(db),
//     provider: new InMemoryBackupProvider(),
//     queue: backupQueue,
//     listVolumeIds: async () => (await db.select({ id: volumes.id }).from(volumes)).map((r) => r.id),
//   });
//
// An external scheduler (Kubernetes CronJob, cloud scheduler) hitting `enqueueDailyBackup`
// directly, once a day, is an equally valid alternative that needs no change to this module.
export async function scheduleDailyBackups(
  queue: Queue<RunBackupJobData>,
  opts: { cronPattern?: string } = {},
): Promise<void> {
  await queue.add(
    DAILY_BACKUP_TICK_JOB,
    // The tick job carries no payload; `queue` is typed for RunBackupJobData because that's the
    // job it's otherwise used for, so an empty object is cast rather than widening that type.
    {} as RunBackupJobData,
    {
      // Singleton: re-registering the same schedule on every boot doesn't duplicate it.
      jobId: DAILY_BACKUP_TICK_JOB,
      repeat: { pattern: opts.cronPattern ?? DAILY_BACKUP_CRON_DEFAULT },
      removeOnComplete: true,
      removeOnFail: 100,
    },
  );
}
