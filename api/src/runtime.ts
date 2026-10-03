// Read-only runtime port the API uses for observability (log tailing and metrics snapshot).
// Mirrors workers/src/runtime/adapter.ts (RuntimeAdapter): the API only reads the runtime, never
// writes to it — the reconciler is the only writer (architecture.md §5.2, §10). Keeps its own
// minimal copy of the contract instead of depending on the workers package, which isn't a
// library (its `index.ts` is a process with side effects on import).
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

// Same convention as workers/src/runtime/adapter.ts: both sides need to produce the same reference.
export function workloadName(serviceInstanceId: string): string {
  return `wl-${serviceInstanceId}`;
}

export function namespaceFor(environmentId: string): string {
  return `env-${environmentId}`;
}
