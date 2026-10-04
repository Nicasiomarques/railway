import { createHash } from "node:crypto";

// Runtime port (architecture.md §3). Only the reconciler calls this interface.
// Implementations: InMemoryRuntime (tests) and K8sRuntime (k3s).

// Autoscaling (roadmap.md Phase 4). When present on a WorkloadSpec, the runtime is expected to
// hand control of the workload's replica count to this policy instead of the spec's own
// `replicas` field (see K8sRuntime.applyWorkload: with a policy, the Deployment's `spec.replicas`
// is left unset so a HorizontalPodAutoscaler can own it without fighting every redeploy).
export interface AutoscalingPolicy {
  minReplicas: number;
  maxReplicas: number;
  targetCpuPercent: number;
  // HPA computes CPU *utilization* as a percentage of the container's CPU request, so one has to
  // exist for the target to mean anything -- this is that request, in millicores (e.g. 250 = "250m").
  cpuRequestMillicores: number;
}

export interface WorkloadSpec {
  // Deterministic per instance, so the runtime finds the same workload on every call.
  name: string;
  // One namespace per environment (architecture.md §7.2): prod stays isolated from preview.
  namespace: string;
  // Image by digest (`registry/app@sha256:...`), never by tag.
  image: string;
  env: Record<string, string>;
  // Baseline/manual replica count. Ignored by the runtime (in favor of the policy) once
  // `autoscaling` is set, but still required: it's what the workload reverts to when autoscaling
  // is turned back off.
  replicas: number;
  autoscaling?: AutoscalingPolicy;
}

export interface WorkloadRef {
  name: string;
  namespace: string;
}

export interface WorkloadStatus {
  image: string;
  replicas: number;
  // Ready replicas *of the current spec*. Pods from a previous version don't count.
  readyReplicas: number;
}

export interface RuntimeAdapter {
  // Idempotent upsert: applying the same spec again changes nothing.
  applyWorkload(spec: WorkloadSpec): Promise<void>;
  getStatus(ref: WorkloadRef): Promise<WorkloadStatus | null>;
  // Tails the workload's stdout/stderr. No Loki/Vector pipeline in the MVP (architecture.md §9):
  // it's a direct read from the runtime, not storage. `since` is an RFC3339 timestamp; without it, shows everything available.
  tailLogs(ref: WorkloadRef, opts?: { since?: string }): AsyncIterable<string>;
}

// Multi-region (roadmap.md Phase 4). A region is, concretely, one Kubernetes cluster: the reconciler
// resolves the RuntimeAdapter for a deployment's project by its regionId instead of talking to a
// single cluster directly (see runtime/registry.ts for the implementations, and db/src/schema.ts's
// `regions` table / `projects.regionId` for where the id comes from).
export interface RuntimeRegistry {
  forRegion(regionId: string): RuntimeAdapter;
}

export function workloadName(serviceInstanceId: string): string {
  return `wl-${serviceInstanceId}`;
}

export function namespaceFor(environmentId: string): string {
  return `env-${environmentId}`;
}

// Hash of what changes the pod's behavior: image and env. Replicas aren't included: scaling isn't a rollout.
export function specHash(spec: Pick<WorkloadSpec, "image" | "env">): string {
  const env = Object.entries(spec.env).sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256").update(JSON.stringify({ image: spec.image, env })).digest("hex").slice(0, 16);
}
