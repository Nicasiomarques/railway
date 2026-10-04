import type { RuntimeAdapter, WorkloadRef, WorkloadSpec, WorkloadStatus } from "./adapter.js";
import type { EnvironmentQuota, EnvironmentRuntime } from "./environment.js";

// Simulated runtime: a rollout starts with no ready replicas and only becomes ready when `markReady` is called.
export class InMemoryRuntime implements RuntimeAdapter, EnvironmentRuntime {
  private readonly workloads = new Map<string, { spec: WorkloadSpec; readyReplicas: number }>();
  private readonly namespaces = new Map<string, Record<string, string>>();
  private readonly policies = new Set<string>();
  private readonly quotas = new Map<string, EnvironmentQuota>();
  private readonly logs = new Map<string, string[]>();

  async ensureNamespace(namespace: string, labels: Record<string, string>): Promise<void> {
    this.namespaces.set(namespace, { ...this.namespaces.get(namespace), ...labels });
  }

  async applyDefaultDenyPolicy(namespace: string): Promise<void> {
    this.policies.add(namespace);
  }

  async applyQuota(namespace: string, quota: EnvironmentQuota): Promise<void> {
    this.quotas.set(namespace, structuredClone(quota));
  }

  // Reads for tests to check the state of the simulated environment.
  environmentState(namespace: string) {
    return {
      labels: this.namespaces.get(namespace) ?? null,
      defaultDeny: this.policies.has(namespace),
      quota: this.quotas.get(namespace) ?? null,
    };
  }

  async applyWorkload(spec: WorkloadSpec): Promise<void> {
    const current = this.workloads.get(spec.name);
    if (current && sameSpec(current.spec, spec)) return;
    this.workloads.set(spec.name, { spec: structuredClone(spec), readyReplicas: 0 });
  }

  async getStatus({ name }: WorkloadRef): Promise<WorkloadStatus | null> {
    const current = this.workloads.get(name);
    if (!current) return null;
    return {
      image: current.spec.image,
      replicas: current.spec.replicas,
      readyReplicas: current.readyReplicas,
    };
  }

  // Populates a workload's simulated log buffer; tests call this to control the tail's content.
  seedLogs(name: string, lines: string[]): void {
    this.logs.set(name, [...(this.logs.get(name) ?? []), ...lines]);
  }

  // Deterministic: returns whatever was populated via `seedLogs`, or a simulated line if the
  // workload exists (no Loki/Vector pipeline in the MVP — architecture.md §9, direct runtime tail).
  async *tailLogs({ name }: WorkloadRef, _opts: { since?: string } = {}): AsyncIterable<string> {
    const seeded = this.logs.get(name);
    if (seeded) {
      for (const line of seeded) yield line;
      return;
    }
    if (this.workloads.has(name)) yield `[sim] ${name}: workload running`;
  }

  // Simulates the workload's replicas becoming ready (health probe passing).
  markReady(name: string): void {
    const current = this.workloads.get(name);
    if (!current) throw new Error(`workload ${name} does not exist`);
    current.readyReplicas = current.spec.replicas;
  }

  markUnready(name: string): void {
    const current = this.workloads.get(name);
    if (!current) throw new Error(`workload ${name} does not exist`);
    current.readyReplicas = 0;
  }

  // Like markReady, but to an explicit count rather than the spec's own `replicas` -- needed to
  // simulate an autoscaled workload, where what the reconciler waits for is the autoscaling
  // policy's minReplicas, not `replicas` (see reconcile.ts's isReady).
  setReadyReplicas(name: string, count: number): void {
    const current = this.workloads.get(name);
    if (!current) throw new Error(`workload ${name} does not exist`);
    current.readyReplicas = count;
  }
}

function sameSpec(a: WorkloadSpec, b: WorkloadSpec): boolean {
  const normalize = (s: WorkloadSpec) =>
    JSON.stringify({ image: s.image, replicas: s.replicas, env: Object.entries(s.env).sort(([x], [y]) => x.localeCompare(y)) });
  return normalize(a) === normalize(b);
}
