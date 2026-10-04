import type { Queue } from "bullmq";
import { type CronTriggerJobData, type ReconcileJobData } from "@railway-like/shared";
import { enqueueReconcile } from "../reconciler/worker.js";
import type { CronStore } from "./store.js";

export interface CronWorkerDeps {
  store: CronStore;
  // Producer side of the same deployments queue: a cron trigger, once it has created the new
  // Deployment row, re-enqueues a RECONCILE_JOB for it exactly like the API does after a manual
  // deployment (api/src/routes/deployments.ts).
  reconcileQueue: Queue<ReconcileJobData>;
}

export type HandleCronTriggerResult = { kind: "queued"; versionNo: number } | { kind: "skipped"; reason: string };

// Fired by a cron instance's repeatable job (workers/src/cron/scheduler.ts). Hooked into the main
// deployments Worker by job name -- see workers/src/reconciler/worker.ts's dispatch and the `cron`
// deps it takes -- the same way CANCEL_BUILD_JOB and PROVISION_ENVIRONMENT_JOB share that queue.
//
// --- What "running a cron job" means here (and what it doesn't) -------------------------------
//
// Phase 4 of docs/roadmap.md asks for "cron jobs" as a service kind. What a cron job conceptually
// needs is an ephemeral Job/Pod that runs to completion and exits -- not a long-running workload.
// `RuntimeAdapter` (workers/src/runtime/adapter.ts) only exposes `applyWorkload`, built for
// long-running replicas with a health check; it has no "run once and report exit code" primitive.
//
// Rather than block cron support on a RuntimeAdapter extension, each scheduled tick is implemented
// as: create a new Deployment for the instance, reusing its last known image/commit (+ env
// snapshot) under `trigger: "cron"`, then enqueue a RECONCILE_JOB for it exactly like a manual
// redeploy. The reconciler already knows how to converge an instance to a given deployment version
// (workers/src/reconciler/reconcile.ts), so this reuses that convergence instead of duplicating it.
//
// This is a known, documented limitation: it redeploys/restarts the workload rather than running a
// true run-to-completion Job, and it depends on the instance having been deployed at least once
// before (there's no image/commit to build/run otherwise -- see "no_previous_deployment" below).
// Proper Job/Pod semantics need a future `RuntimeAdapter.runJob`-style addition (and a matching
// reconciler status machine for "ran and exited" vs. "Running"), which is out of scope here.
export async function handleCronTriggerJob(deps: CronWorkerDeps, data: CronTriggerJobData): Promise<HandleCronTriggerResult> {
  const result = await deps.store.triggerRun(data.serviceInstanceId);
  if (result.kind === "instance_not_found") {
    return { kind: "skipped", reason: "instance not found (likely deleted)" };
  }
  if (result.kind === "no_previous_deployment") {
    return { kind: "skipped", reason: "instance has no previous deployment to re-run yet" };
  }

  await enqueueReconcile(deps.reconcileQueue, { serviceInstanceId: data.serviceInstanceId, versionNo: result.versionNo });
  return { kind: "queued", versionNo: result.versionNo };
}
