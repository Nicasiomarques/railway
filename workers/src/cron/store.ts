// What the cron trigger handler needs from the data layer. Deliberately minimal and self-contained:
// `createQueuedDeployment` (api/src/routes/deployments.ts) is the "real" deployment-creation path,
// but it lives in the api package and pulls in the keyring/env-snapshot machinery. Workers don't
// depend on api (see workers/src/reconciler, workers/src/domain, workers/src/backup for the same
// pattern), so this re-implements just the minimal slice needed to "redeploy the instance's last
// known build" under trigger "cron". See workers/src/cron/worker.ts for why that's the chosen
// meaning of "running a cron job" here.

export interface CronInstance {
  serviceInstanceId: string;
  // Cron expression, e.g. "0 3 * * *".
  schedule: string;
}

export type TriggerCronResult =
  | { kind: "queued"; versionNo: number }
  | { kind: "no_previous_deployment" }
  | { kind: "instance_not_found" };

export interface CronStore {
  // Every service_instances row whose service has kind "cron" and a non-null schedule, excluding
  // soft-deleted services/instances.
  listCronInstances(): Promise<CronInstance[]>;

  // Creates a new Deployment for the instance under trigger "cron", reusing the most recent
  // deployment's image/commit/env snapshot (so there's something to build/run; config hasn't
  // changed just because the schedule fired). "no_previous_deployment" when the instance was never
  // deployed yet -- there's nothing to re-run, so the tick is a no-op rather than an error.
  triggerRun(serviceInstanceId: string): Promise<TriggerCronResult>;
}
