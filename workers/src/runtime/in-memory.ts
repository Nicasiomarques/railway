import type { RuntimeAdapter, WorkloadRef, WorkloadSpec, WorkloadStatus } from "./adapter.js";
import type { EnvironmentQuota, EnvironmentRuntime } from "./environment.js";

// Runtime simulado: um rollout começa sem réplicas prontas e só fica pronto quando `markReady` é chamado.
export class InMemoryRuntime implements RuntimeAdapter, EnvironmentRuntime {
  private readonly workloads = new Map<string, { spec: WorkloadSpec; readyReplicas: number }>();
  private readonly namespaces = new Map<string, Record<string, string>>();
  private readonly policies = new Set<string>();
  private readonly quotas = new Map<string, EnvironmentQuota>();

  async ensureNamespace(namespace: string, labels: Record<string, string>): Promise<void> {
    this.namespaces.set(namespace, { ...this.namespaces.get(namespace), ...labels });
  }

  async applyDefaultDenyPolicy(namespace: string): Promise<void> {
    this.policies.add(namespace);
  }

  async applyQuota(namespace: string, quota: EnvironmentQuota): Promise<void> {
    this.quotas.set(namespace, structuredClone(quota));
  }

  // Leituras para os testes verificarem o estado do ambiente simulado.
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

  // Simula as réplicas do workload ficando prontas (sondagem de saúde passando).
  markReady(name: string): void {
    const current = this.workloads.get(name);
    if (!current) throw new Error(`workload ${name} não existe`);
    current.readyReplicas = current.spec.replicas;
  }

  markUnready(name: string): void {
    const current = this.workloads.get(name);
    if (!current) throw new Error(`workload ${name} não existe`);
    current.readyReplicas = 0;
  }
}

function sameSpec(a: WorkloadSpec, b: WorkloadSpec): boolean {
  const normalize = (s: WorkloadSpec) =>
    JSON.stringify({ image: s.image, replicas: s.replicas, env: Object.entries(s.env).sort(([x], [y]) => x.localeCompare(y)) });
  return normalize(a) === normalize(b);
}
