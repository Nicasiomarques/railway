// Porta de leitura do runtime que a API usa para observabilidade (tail de logs e snapshot de métricas).
// Espelha workers/src/runtime/adapter.ts (RuntimeAdapter): a API só lê o runtime, nunca escreve nele —
// o reconciliador é o único escritor (architecture.md §5.2, §10). Fica com a sua própria cópia mínima
// do contrato em vez de depender do pacote dos workers, que não é uma biblioteca (seu `index.ts` é um
// processo com efeitos colaterais ao ser importado).
export interface WorkloadRef {
  name: string;
  namespace: string;
}

export interface WorkloadStatus {
  image: string;
  replicas: number;
  readyReplicas: number;
}

export interface RuntimeReader {
  getStatus(ref: WorkloadRef): Promise<WorkloadStatus | null>;
  tailLogs(ref: WorkloadRef, opts?: { since?: string }): AsyncIterable<string>;
}

// Mesma convenção de workers/src/runtime/adapter.ts: os dois lados precisam gerar a mesma referência.
export function workloadName(serviceInstanceId: string): string {
  return `wl-${serviceInstanceId}`;
}

export function namespaceFor(environmentId: string): string {
  return `env-${environmentId}`;
}
