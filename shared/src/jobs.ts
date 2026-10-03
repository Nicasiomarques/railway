// Contrato dos jobs de deployment entre API (produtor) e workers (consumidores).
// Sem dependências de runtime: pode ser importado de qualquer pacote.

export const DEPLOYMENTS_QUEUE = "deployments";
export const RECONCILE_JOB = "reconcile-instance";

export interface ReconcileJobData {
  serviceInstanceId: string;
  versionNo: number;
}

// Pendências (build em andamento, réplicas ainda não prontas) re-enfileiram em intervalo fixo:
// backoff exponencial deixaria a detecção de conclusão atrasar vários minutos.
// 240 tentativas × 5s ≈ 20 min de orçamento.
export const RECONCILE_JOB_RETRY = {
  attempts: 240,
  backoff: { type: "fixed", delay: 5000 },
  removeOnComplete: true,
  removeOnFail: 100,
} as const;

// Um job por versão: reenfileirar a mesma versão não duplica trabalho, e uma versão nova
// nunca fica presa atrás de um job ativo de outra versão.
export function reconcileJobId(data: ReconcileJobData): string {
  return `reconcile-${data.serviceInstanceId}-v${data.versionNo}`;
}

// Job que apaga o Job de build de um deployment cancelado. Vai na mesma fila; o worker escolhe pelo nome.
export const CANCEL_BUILD_JOB = "cancel-build";

export interface CancelBuildJobData {
  deploymentId: string;
  serviceInstanceId: string;
}

export const CANCEL_BUILD_JOB_RETRY = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: true,
  removeOnFail: 100,
} as const;

// Saga de provisionamento de ambiente (architecture.md §6): namespace, NetworkPolicy e quotas.
// Vai na mesma fila; o worker escolhe pelo nome do job. Um job por ambiente: reenfileirar não duplica a saga.
export const PROVISION_ENVIRONMENT_JOB = "provision-environment";

export interface ProvisionEnvironmentJobData {
  environmentId: string;
}

export function provisionEnvironmentJobId(data: ProvisionEnvironmentJobData): string {
  return `provision-${data.environmentId}`;
}

// Passos com falha transitória (API do cluster indisponível) são repetidos; o estado dos passos já concluídos é preservado.
export const PROVISION_ENVIRONMENT_JOB_RETRY = {
  attempts: 10,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: true,
  removeOnFail: 100,
} as const;
