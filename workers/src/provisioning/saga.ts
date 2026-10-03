import type { ProvisionEnvironmentJobData } from "@railway-like/shared";
import { environmentLabels, DEFAULT_ENV_QUOTA, type EnvironmentRuntime } from "../runtime/environment.js";
import { namespaceFor } from "../runtime/adapter.js";

// Ordem dos passos (architecture.md §6). Cada um é um upsert: repetir um passo já aplicado não muda nada.
export const PROVISIONING_STEPS = ["namespace", "default-deny-policy", "quota"] as const;
export type ProvisioningStep = (typeof PROVISIONING_STEPS)[number];

export type ProvisioningStatus = "pending" | "provisioning" | "ready" | "failed";

export interface EnvironmentRecord {
  id: string;
  projectId: string;
  status: ProvisioningStatus;
  completedSteps: string[];
}

export interface EnvironmentProvisioningStore {
  findEnvironment(environmentId: string): Promise<EnvironmentRecord | null>;
  // Marca o início (ou a retomada) da saga. Não apaga os passos já concluídos.
  markProvisioning(environmentId: string): Promise<void>;
  markStepDone(environmentId: string, step: ProvisioningStep): Promise<void>;
  // Registra o erro sem mudar o status: a saga ainda pode ser retentada.
  recordError(environmentId: string, reason: string): Promise<void>;
  markReady(environmentId: string): Promise<void>;
  markFailed(environmentId: string, reason: string): Promise<void>;
}

export interface ProvisioningDeps {
  store: EnvironmentProvisioningStore;
  runtime: EnvironmentRuntime;
}

export type ProvisionResult =
  | { kind: "ready"; environmentId: string }
  | { kind: "missing"; environmentId: string }
  | { kind: "failed"; environmentId: string };

// Executa os passos que faltam. Se um passo falhar, lança o erro: o chamador decide entre retentar ou marcar como failed.
export async function provisionEnvironment(
  deps: ProvisioningDeps,
  { environmentId }: ProvisionEnvironmentJobData,
): Promise<ProvisionResult> {
  const env = await deps.store.findEnvironment(environmentId);
  if (!env) return { kind: "missing", environmentId };
  if (env.status === "ready") return { kind: "ready", environmentId };

  await deps.store.markProvisioning(environmentId);

  const namespace = namespaceFor(environmentId);
  const done = new Set(env.completedSteps);
  for (const step of PROVISIONING_STEPS) {
    if (done.has(step)) continue;
    await runStep(deps.runtime, step, namespace, env);
    await deps.store.markStepDone(environmentId, step);
  }

  await deps.store.markReady(environmentId);
  return { kind: "ready", environmentId };
}

async function runStep(runtime: EnvironmentRuntime, step: ProvisioningStep, namespace: string, env: EnvironmentRecord) {
  switch (step) {
    case "namespace":
      return runtime.ensureNamespace(namespace, environmentLabels(env.projectId, env.id));
    case "default-deny-policy":
      return runtime.applyDefaultDenyPolicy(namespace);
    case "quota":
      return runtime.applyQuota(namespace, DEFAULT_ENV_QUOTA);
  }
}

// Entrada do job na fila. Erro transitório: registra e relança, para o BullMQ retentar (os passos concluídos são preservados).
// Na última tentativa, ou com erro permanente, o ambiente vira failed.
export async function handleProvisionEnvironmentJob(
  deps: ProvisioningDeps,
  data: ProvisionEnvironmentJobData,
  budget: { attemptsMade: number; maxAttempts: number },
): Promise<ProvisionResult> {
  try {
    return await provisionEnvironment(deps, data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!isLastAttempt(budget)) {
      await deps.store.recordError(data.environmentId, message);
      throw err;
    }
    await deps.store.markFailed(data.environmentId, `erro após ${budget.maxAttempts} tentativas: ${message}`);
    return { kind: "failed", environmentId: data.environmentId };
  }
}

function isLastAttempt(budget: { attemptsMade: number; maxAttempts: number }): boolean {
  return budget.attemptsMade + 1 >= budget.maxAttempts;
}
