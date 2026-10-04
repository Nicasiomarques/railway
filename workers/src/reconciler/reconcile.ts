import { transition, type DeploymentStatus } from "@railway-like/shared";
import { namespaceFor, workloadName, type RuntimeAdapter, type WorkloadSpec, type WorkloadStatus } from "../runtime/adapter.js";
import type { BuildRequest, Builder } from "../build/builder.js";
import { PermanentError } from "./errors.js";
import type { DeploymentRecord, DeploymentStore } from "./store.js";

export interface ReconcilerDeps {
  store: DeploymentStore;
  runtime: RuntimeAdapter;
  // Required for repository deployments. Without it, those deployments fail permanently.
  builder?: Builder;
}

export type ReconcileResult =
  | { kind: "idle" }
  | { kind: "converged"; deploymentId: string }
  | { kind: "pending"; deploymentId: string; reason: string; phase: "Building" | "HealthChecking" }
  | { kind: "failed"; deploymentId: string };

// Converges the instance's runtime to the active deployment. Idempotent: can run multiple times
// with the same result. Only this module writes to the runtime.
export async function reconcileInstance(deps: ReconcilerDeps, serviceInstanceId: string): Promise<ReconcileResult> {
  const maxRaces = 3;
  for (let i = 0; i < maxRaces; i++) {
    const active = await deps.store.findActive(serviceInstanceId);
    if (!active) return { kind: "idle" };

    const result = await reconcileDeployment(deps, active);
    if (result) return result;
    // Another writer touched the deployment between the read and the write: re-read and try again.
  }
  throw new Error(`reconcile ${serviceInstanceId}: state kept changing throughout the attempt`);
}

// Returns null when it lost a write race and the caller should re-read the state.
async function reconcileDeployment(deps: ReconcilerDeps, d: DeploymentRecord): Promise<ReconcileResult | null> {
  let rec = d;
  let phase: DeploymentStatus = d.status;

  if (phase === "Queued") {
    const reason = rec.imageDigest ? "build skipped: image provided by digest" : "build started";
    if (!(await advance(deps.store, rec.id, "Queued", "Building", reason))) return null;
    phase = "Building";
  }

  if (phase === "Building") {
    if (!rec.imageDigest) {
      const outcome = await runBuild(deps, rec);
      await captureBuildLogs(deps, rec);
      if (outcome.kind === "running") {
        return { kind: "pending", deploymentId: rec.id, reason: "build in progress", phase: "Building" };
      }
      if (outcome.kind === "failed") throw new PermanentError(`build failed: ${outcome.reason}`, rec.id);
      if (!(await deps.store.setImageDigest(rec.id, outcome.imageDigest))) return null;
      rec = { ...rec, imageDigest: outcome.imageDigest };
      if (!(await advance(deps.store, rec.id, "Building", "Deploying", "build finished"))) return null;
    } else if (!(await advance(deps.store, rec.id, "Building", "Deploying"))) {
      return null;
    }
    phase = "Deploying";
  }

  const image = rec.imageDigest;
  if (!image) throw new PermanentError(`deployment ${rec.id} has no image_digest: cannot converge`, rec.id);
  const spec = specFor({ ...rec, imageDigest: image });

  if (phase === "Deploying") {
    await deps.runtime.applyWorkload(spec);
    if (!(await advance(deps.store, rec.id, "Deploying", "HealthChecking"))) return null;
  }

  // From here on the deployment is in HealthChecking.
  const status = await deps.runtime.getStatus({ name: spec.name, namespace: spec.namespace });
  if (!isReady(status, spec)) {
    return { kind: "pending", deploymentId: rec.id, reason: "replicas are not ready yet", phase: "HealthChecking" };
  }
  if (!(await deps.store.promote(rec.id))) return null;
  return { kind: "converged", deploymentId: rec.id };
}

// Logs are diagnostics: failing to read them must not change the build's result.
async function captureBuildLogs(deps: ReconcilerDeps, d: DeploymentRecord): Promise<void> {
  if (!deps.builder) return;
  try {
    await deps.store.saveBuildLog(d.id, await deps.builder.logs({ deploymentId: d.id, serviceInstanceId: d.serviceInstanceId }));
  } catch {
    // Keeps the last saved snapshot.
  }
}

// Starts (idempotently) and checks the build of a repository deployment.
async function runBuild(deps: ReconcilerDeps, d: DeploymentRecord) {
  if (!deps.builder) throw new PermanentError("builder not configured for repository deployment", d.id);
  if (!d.commitSha || !d.repoUrl) throw new PermanentError(`deployment ${d.id} has no commit or repository`, d.id);

  const req: BuildRequest = {
    deploymentId: d.id,
    serviceInstanceId: d.serviceInstanceId,
    repoUrl: d.repoUrl,
    commitSha: d.commitSha,
    rootDir: d.rootDir,
  };
  await deps.builder.start(req);
  return deps.builder.status(req);
}

// Decides what to do with a reconciliation job.
// - Permanent error: the deployment goes to Failed right away.
// - Transient error: retries up to the last attempt; on it, the deployment goes to Failed with the reason.
// - Pending (build or health check): retries; on the last attempt, goes to Failed saying which phase it stopped in.
// `budget` comes from BullMQ, so the budget lives in the queue rather than in memory.
export async function handleReconcileJob(
  deps: ReconcilerDeps,
  data: { serviceInstanceId: string },
  budget: { attemptsMade: number; maxAttempts: number },
): Promise<ReconcileResult> {
  const lastAttempt = budget.attemptsMade + 1 >= budget.maxAttempts;

  let result: ReconcileResult;
  try {
    result = await reconcileInstance(deps, data.serviceInstanceId);
  } catch (err) {
    const permanent = err instanceof PermanentError;
    if (!permanent && !lastAttempt) throw err;

    const deploymentId = permanent && err.deploymentId ? err.deploymentId : (await deps.store.findActive(data.serviceInstanceId))?.id;
    if (!deploymentId) throw err;

    const reason = permanent ? err.message : `error after ${budget.maxAttempts} attempts: ${(err as Error).message}`;
    await failDeployment(deps.store, deploymentId, reason);
    return { kind: "failed", deploymentId };
  }

  if (result.kind !== "pending") return result;

  if (!lastAttempt) {
    throw new Error(`${result.reason} (attempt ${budget.attemptsMade + 1} of ${budget.maxAttempts})`);
  }
  const what = result.phase === "Building" ? "build did not finish" : "health check did not pass";
  await failDeployment(deps.store, result.deploymentId, `${what} after ${budget.maxAttempts} attempts: ${result.reason}`);
  return { kind: "failed", deploymentId: result.deploymentId };
}

// Marks the active deployment as Failed, from whatever state it's currently in.
async function failDeployment(store: DeploymentStore, id: string, reason: string): Promise<void> {
  for (const from of ["HealthChecking", "Deploying", "Building"] as const) {
    transition(from, "Failed");
    if (await store.setStatus(id, from, "Failed", reason)) return;
  }
  throw new Error(`deployment ${id} changed during the failure; try again`);
}

// Validates the transition in the state machine before writing. Throws if the transition doesn't exist.
async function advance(
  store: DeploymentStore,
  id: string,
  from: DeploymentStatus,
  to: DeploymentStatus,
  reason?: string,
): Promise<boolean> {
  transition(from, to);
  return store.setStatus(id, from, to, reason);
}

function specFor(d: DeploymentRecord & { imageDigest: string }): WorkloadSpec {
  return {
    name: workloadName(d.serviceInstanceId),
    namespace: namespaceFor(d.environmentId),
    image: d.imageDigest,
    env: d.env,
    replicas: d.replicas,
    ...(d.autoscaling ? { autoscaling: d.autoscaling } : {}),
  };
}

// Ready = this deployment's image has its replicas ready. A workload with the old image doesn't count.
// With autoscaling on, the Deployment's replica count is the HPA's to decide (see k8s.ts), so the
// floor to wait for here is the policy's minReplicas rather than the spec's own (unused) `replicas`.
function isReady(status: WorkloadStatus | null, spec: WorkloadSpec): boolean {
  const wantReplicas = spec.autoscaling?.minReplicas ?? spec.replicas;
  return status !== null && status.image === spec.image && status.readyReplicas >= wantReplicas;
}
