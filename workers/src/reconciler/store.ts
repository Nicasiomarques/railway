import type { DeploymentStatus } from "@railway-like/shared";
import type { AutoscalingPolicy } from "../runtime/adapter.js";

// What the reconciler needs from a deployment. Postgres is the source of truth (architecture.md §1).
export interface DeploymentRecord {
  id: string;
  serviceInstanceId: string;
  environmentId: string;
  versionNo: number;
  status: DeploymentStatus;
  // Image by digest. Null while the deployment hasn't been built yet (github_repo source).
  imageDigest: string | null;
  // Build source: only for github_repo deployments.
  commitSha: string | null;
  repoUrl: string | null;
  rootDir: string;
  env: Record<string, string>;
  replicas: number;
  // Read live from the instance at reconcile time, same as `replicas` above -- not frozen into the
  // deployment. Null when the instance has autoscaling off, in which case `replicas` governs directly.
  autoscaling: AutoscalingPolicy | null;
}

export interface DeploymentStore {
  // The instance's most recent deployment in Deploying or HealthChecking.
  findActive(serviceInstanceId: string): Promise<DeploymentRecord | null>;

  // Latest snapshot of the deployment's build logs. Overwrites the previous one.
  saveBuildLog(id: string, content: string): Promise<void>;

  // Records the digest produced by the build. Only if there isn't one yet: a finished build isn't overwritten.
  setImageDigest(id: string, imageDigest: string): Promise<boolean>;

  // Compare-and-set: writes `to` only if the current status is still `from`. Returns false on a race.
  // The caller validates the transition with `transition()` beforehand; the store doesn't decide business rules.
  setStatus(id: string, from: DeploymentStatus, to: DeploymentStatus, reason?: string): Promise<boolean>;

  // Atomically: the deployment in HealthChecking becomes Running and the previous Running of the same instance becomes Superseded.
  // Must be atomic: if only one of the two writes happens, the instance ends up with two Running.
  promote(id: string): Promise<boolean>;
}
