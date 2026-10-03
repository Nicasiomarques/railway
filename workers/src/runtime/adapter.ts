import { createHash } from "node:crypto";

// Runtime port (architecture.md §3). Only the reconciler calls this interface.
// Implementations: InMemoryRuntime (tests) and K8sRuntime (k3s).

export interface WorkloadSpec {
  // Deterministic per instance, so the runtime finds the same workload on every call.
  name: string;
  // One namespace per environment (architecture.md §7.2): prod stays isolated from preview.
  namespace: string;
  // Image by digest (`registry/app@sha256:...`), never by tag.
  image: string;
  env: Record<string, string>;
  replicas: number;
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
