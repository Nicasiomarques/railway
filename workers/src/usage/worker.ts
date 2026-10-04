import { Queue, Worker, type ConnectionOptions, type JobsOptions } from "bullmq";
import {
  SAMPLE_USAGE_JOB,
  SAMPLE_USAGE_JOB_RETRY,
  USAGE_QUEUE,
  USAGE_SAMPLING_CRON_DEFAULT,
  USAGE_SAMPLING_TICK_JOB,
  sampleUsageJobId,
  type SampleUsageJobData,
} from "@railway-like/shared";
import { namespaceFor, workloadName, type RuntimeAdapter } from "../runtime/adapter.js";
import type { UsageStore } from "./store.js";

// Constants and contract come from @railway-like/shared: whoever produces a sample-usage job
// (today, only this module itself) agrees on the same rules.
export { USAGE_QUEUE, SAMPLE_USAGE_JOB, type SampleUsageJobData };

export const SAMPLE_USAGE_JOB_OPTIONS: JobsOptions = SAMPLE_USAGE_JOB_RETRY;

export async function enqueueSampleUsage(queue: Queue<SampleUsageJobData>, data: SampleUsageJobData): Promise<void> {
  await queue.add(SAMPLE_USAGE_JOB, data, { ...SAMPLE_USAGE_JOB_OPTIONS, jobId: sampleUsageJobId(data) });
}

// Enqueues one sample-usage job per active instance. This is the function a recurring schedule
// ultimately calls (directly, or through the `usage-sampling-tick` job handled below); see
// `scheduleUsageSampling` for how this workstream expects that schedule to be wired to a real cron.
export async function enqueueUsageSamplingTick(queue: Queue<SampleUsageJobData>, instanceIds: string[]): Promise<void> {
  for (const serviceInstanceId of instanceIds) {
    await enqueueSampleUsage(queue, { serviceInstanceId });
  }
}

export interface UsageWorkerDeps {
  store: UsageStore;
  runtime: RuntimeAdapter;
  // How many minutes of replica-time one sample represents. Defaults to 1, matching the finest
  // aggregation window in architecture.md §4 and the default cron in scheduleUsageSampling.
  sampleIntervalMinutes?: number;
  // Only used to process the recurring `usage-sampling-tick` job (see scheduleUsageSampling
  // below). workers/src/index.ts registers this worker without them today, since there's no
  // production schedule yet — a tick job simply never arrives, and the worker ignores it if one
  // does.
  queue?: Queue<SampleUsageJobData>;
  listActiveInstanceIds?: () => Promise<string[]>;
}

export type SampleUsageResult =
  | { kind: "recorded"; replicas: number }
  | { kind: "no_workload" }
  | { kind: "not_found" };

// Samples one instance's current runtime state and appends it to usage_events (architecture.md
// §3: "Usage aggregator | Samples -> usage_events per project/service | Feeds future billing").
// Unlike the backup/domain workers there's no state machine to advance: a sample is a single
// point-in-time read, so there's nothing to retry *towards* — a transient runtime failure just
// throws, and BullMQ's own retry budget (SAMPLE_USAGE_JOB_RETRY) covers it.
export async function handleSampleUsageJob(deps: UsageWorkerDeps, data: SampleUsageJobData): Promise<SampleUsageResult> {
  const instance = await deps.store.getInstance(data.serviceInstanceId);
  if (!instance) return { kind: "not_found" };

  const ref = { name: workloadName(instance.id), namespace: namespaceFor(instance.environmentId) };
  const status = await deps.runtime.getStatus(ref);
  if (!status) return { kind: "no_workload" };

  const minutes = deps.sampleIntervalMinutes ?? 1;
  await deps.store.recordSample({
    projectId: instance.projectId,
    serviceInstanceId: instance.id,
    // The only metric this worker writes today: replicas observed times the sampling interval,
    // so summing `value` directly gives replica-minutes over any window (architecture.md §4).
    metric: "replica_minutes",
    value: status.replicas * minutes,
    occurredAt: new Date(),
  });
  return { kind: "recorded", replicas: status.replicas };
}

export function createUsageWorker(connection: ConnectionOptions, deps: UsageWorkerDeps): Worker {
  return new Worker(
    USAGE_QUEUE,
    async (job) => {
      if (job.name === USAGE_SAMPLING_TICK_JOB) {
        // Nothing wires queue/listActiveInstanceIds in production yet (see scheduleUsageSampling
        // below); a tick job that arrives without them configured is a no-op rather than a crash.
        if (!deps.queue || !deps.listActiveInstanceIds) return { kind: "skipped" as const };
        await enqueueUsageSamplingTick(deps.queue, await deps.listActiveInstanceIds());
        return { kind: "scheduled" as const };
      }
      return handleSampleUsageJob(deps, job.data as SampleUsageJobData);
    },
    { connection },
  );
}

// --- Sampling schedule -----------------------------------------------------------------------
//
// architecture.md §3/§4 asks for periodic samples of every service instance, appended to
// usage_events and later rolled up in windows (1 min -> hour -> day). This workstream provides the
// mechanism (the `usage-sampling-tick` job name, the enqueueUsageSamplingTick fan-out, and the
// branch in createUsageWorker above that answers a tick), but deliberately does NOT wire a real
// production cron: there's no live need to gate this on yet, and workers/src/index.ts registers
// createUsageWorker with just { store, runtime }, as shown in this file's own createUsageWorker
// signature.
//
// To connect this to a real per-minute cron later, call `scheduleUsageSampling` once at worker
// start-up (it registers a BullMQ *repeatable* job — BullMQ's own scheduler fires it, no external
// cron process required) and pass `queue`/`listActiveInstanceIds` into `createUsageWorker`'s deps
// so the tick is actually acted on:
//
//   const usageQueue = new Queue<SampleUsageJobData>(USAGE_QUEUE, { connection });
//   await scheduleUsageSampling(usageQueue);
//   const usageStore = new PostgresUsageStore(db);
//   const usageWorker = createUsageWorker(connection, {
//     store: usageStore,
//     runtime,
//     queue: usageQueue,
//     listActiveInstanceIds: () => usageStore.listActiveInstanceIds(),
//   });
//
// An external scheduler (Kubernetes CronJob, cloud scheduler) hitting `enqueueUsageSamplingTick`
// directly, once a minute, is an equally valid alternative that needs no change to this module.
export async function scheduleUsageSampling(
  queue: Queue<SampleUsageJobData>,
  opts: { cronPattern?: string } = {},
): Promise<void> {
  await queue.add(
    USAGE_SAMPLING_TICK_JOB,
    // The tick job carries no payload; `queue` is typed for SampleUsageJobData because that's the
    // job it's otherwise used for, so an empty object is cast rather than widening that type.
    {} as SampleUsageJobData,
    {
      // Singleton: re-registering the same schedule on every boot doesn't duplicate it.
      jobId: USAGE_SAMPLING_TICK_JOB,
      repeat: { pattern: opts.cronPattern ?? USAGE_SAMPLING_CRON_DEFAULT },
      removeOnComplete: true,
      removeOnFail: 100,
    },
  );
}
