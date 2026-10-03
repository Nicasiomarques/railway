import type { DeploymentStatus } from "@railway-like/shared";

// O que o reconciliador precisa de um deployment. O Postgres é a fonte da verdade (architecture.md §1).
export interface DeploymentRecord {
  id: string;
  serviceInstanceId: string;
  environmentId: string;
  versionNo: number;
  status: DeploymentStatus;
  // Imagem por digest. Null enquanto o deployment não foi construído (origem github_repo).
  imageDigest: string | null;
  // Origem de build: só para deployments de github_repo.
  commitSha: string | null;
  repoUrl: string | null;
  rootDir: string;
  env: Record<string, string>;
  replicas: number;
}

export interface DeploymentStore {
  // Deployment mais recente da instância em Deploying ou HealthChecking.
  findActive(serviceInstanceId: string): Promise<DeploymentRecord | null>;

  // Último retrato dos logs do build do deployment. Sobrescreve o anterior.
  saveBuildLog(id: string, content: string): Promise<void>;

  // Grava o digest produzido pelo build. Só se ainda não houver um: um build concluído não é sobrescrito.
  setImageDigest(id: string, imageDigest: string): Promise<boolean>;

  // Compare-and-set: grava `to` só se o status atual ainda for `from`. Retorna false em caso de corrida.
  // Quem chama valida a transição com `transition()` antes; o store não decide regras de negócio.
  setStatus(id: string, from: DeploymentStatus, to: DeploymentStatus, reason?: string): Promise<boolean>;

  // Atomicamente: o deployment em HealthChecking vira Running e o Running anterior da mesma instância vira Superseded.
  // Precisa ser atômico: se só uma das duas escritas acontecer, a instância fica com dois Running.
  promote(id: string): Promise<boolean>;
}
