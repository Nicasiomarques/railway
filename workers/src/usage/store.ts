// What the usage worker needs from Postgres. Mirrors the backup worker's BackupStore
// (backup/store.ts): the minimal read/write needed for the worker to safely do its job.

export interface UsageInstanceInfo {
  id: string;
  projectId: string;
  environmentId: string;
}

export interface UsageSample {
  projectId: string;
  serviceInstanceId: string;
  // Free-form key (usage_events.metric); the worker only ever writes "replica_minutes" today
  // (see worker.ts), but the store itself doesn't care what the caller names it.
  metric: string;
  value: number;
  occurredAt: Date;
}

export interface UsageStore {
  // Everything the worker needs about an instance to sample it: where to find its workload
  // (environmentId, to build the runtime namespace) and which project to bill the sample to.
  getInstance(id: string): Promise<UsageInstanceInfo | null>;

  // Append-only (architecture.md §4): never updates or deletes a row.
  recordSample(sample: UsageSample): Promise<void>;

  // All non-deleted service instances, to fan a sampling tick out into one job per instance.
  listActiveInstanceIds(): Promise<string[]>;
}
