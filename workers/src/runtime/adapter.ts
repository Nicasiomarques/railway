import { createHash } from "node:crypto";

// Porta do runtime (architecture.md §3). Só o reconciliador chama esta interface.
// Implementações: InMemoryRuntime (testes) e K8sRuntime (k3s).

export interface WorkloadSpec {
  // Determinístico por instância, para o runtime achar o mesmo workload em cada chamada.
  name: string;
  // Um namespace por ambiente (architecture.md §7.2): prod fica isolado de preview.
  namespace: string;
  // Imagem por digest (`registry/app@sha256:...`), nunca por tag.
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
  // Réplicas prontas *da spec atual*. Pods de uma versão anterior não contam.
  readyReplicas: number;
}

export interface RuntimeAdapter {
  // Upsert idempotente: aplicar o mesmo spec de novo não muda nada.
  applyWorkload(spec: WorkloadSpec): Promise<void>;
  getStatus(ref: WorkloadRef): Promise<WorkloadStatus | null>;
  // Tail do stdout/stderr do workload. Sem pipeline Loki/Vector no MVP (architecture.md §9):
  // é leitura direta do runtime, não armazenamento. `since` é um timestamp RFC3339; sem ele, mostra tudo disponível.
  tailLogs(ref: WorkloadRef, opts?: { since?: string }): AsyncIterable<string>;
}

export function workloadName(serviceInstanceId: string): string {
  return `wl-${serviceInstanceId}`;
}

export function namespaceFor(environmentId: string): string {
  return `env-${environmentId}`;
}

// Hash do que muda o comportamento do pod: imagem e env. Réplicas não entram: escalar não é rollout.
export function specHash(spec: Pick<WorkloadSpec, "image" | "env">): string {
  const env = Object.entries(spec.env).sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256").update(JSON.stringify({ image: spec.image, env })).digest("hex").slice(0, 16);
}
