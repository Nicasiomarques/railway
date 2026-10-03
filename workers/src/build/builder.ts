// Porta de build (architecture.md §3). Só o reconciliador chama esta interface.
// Implementações: InMemoryBuilder (testes) e K8sBuilder (Job de BuildKit no cluster).

export interface BuildRequest {
  deploymentId: string;
  serviceInstanceId: string;
  repoUrl: string;
  commitSha: string;
  // Diretório do Dockerfile dentro do repo ("/" = raiz).
  rootDir: string;
}

export type BuildStatus =
  | { kind: "running" }
  // Referência completa por digest: `registry/repo@sha256:...`.
  | { kind: "succeeded"; imageDigest: string }
  | { kind: "failed"; reason: string };

export interface Builder {
  // Idempotente: iniciar um build que já existe não faz nada.
  start(req: BuildRequest): Promise<void>;
  status(req: Pick<BuildRequest, "deploymentId" | "serviceInstanceId">): Promise<BuildStatus>;
  // Último retrato dos logs dos containers do build (gate, clone, build). Vazio se o build ainda não começou.
  logs(req: Pick<BuildRequest, "deploymentId" | "serviceInstanceId">): Promise<string>;
  // Apaga o build de um deployment cancelado. Idempotente: se o build não existe, não é erro.
  cancel(req: Pick<BuildRequest, "deploymentId" | "serviceInstanceId">): Promise<void>;
}
