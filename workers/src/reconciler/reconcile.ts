import { transition, type DeploymentStatus } from "@railway-like/shared";
import { namespaceFor, workloadName, type RuntimeAdapter, type WorkloadSpec, type WorkloadStatus } from "../runtime/adapter.js";
import type { BuildRequest, Builder } from "../build/builder.js";
import { PermanentError } from "./errors.js";
import type { DeploymentRecord, DeploymentStore } from "./store.js";

export interface ReconcilerDeps {
  store: DeploymentStore;
  runtime: RuntimeAdapter;
  // Obrigatório para deployments de repositório. Sem ele, esses deployments falham de forma permanente.
  builder?: Builder;
}

export type ReconcileResult =
  | { kind: "idle" }
  | { kind: "converged"; deploymentId: string }
  | { kind: "pending"; deploymentId: string; reason: string; phase: "Building" | "HealthChecking" }
  | { kind: "failed"; deploymentId: string };

// Converge o runtime da instância para o deployment ativo. Idempotente: pode rodar várias vezes
// e o resultado é o mesmo. Só este módulo escreve no runtime.
export async function reconcileInstance(deps: ReconcilerDeps, serviceInstanceId: string): Promise<ReconcileResult> {
  const maxRaces = 3;
  for (let i = 0; i < maxRaces; i++) {
    const active = await deps.store.findActive(serviceInstanceId);
    if (!active) return { kind: "idle" };

    const result = await reconcileDeployment(deps, active);
    if (result) return result;
    // Outro escritor mexeu no deployment entre a leitura e a escrita: relê e tenta de novo.
  }
  throw new Error(`reconcile ${serviceInstanceId}: estado mudou durante toda a tentativa`);
}

// Retorna null quando perdeu uma corrida de escrita e o chamador deve reler o estado.
async function reconcileDeployment(deps: ReconcilerDeps, d: DeploymentRecord): Promise<ReconcileResult | null> {
  let rec = d;
  let phase: DeploymentStatus = d.status;

  if (phase === "Queued") {
    const reason = rec.imageDigest ? "build dispensado: imagem fornecida por digest" : "build iniciado";
    if (!(await advance(deps.store, rec.id, "Queued", "Building", reason))) return null;
    phase = "Building";
  }

  if (phase === "Building") {
    if (!rec.imageDigest) {
      const outcome = await runBuild(deps, rec);
      await captureBuildLogs(deps, rec);
      if (outcome.kind === "running") {
        return { kind: "pending", deploymentId: rec.id, reason: "build em andamento", phase: "Building" };
      }
      if (outcome.kind === "failed") throw new PermanentError(`build falhou: ${outcome.reason}`, rec.id);
      if (!(await deps.store.setImageDigest(rec.id, outcome.imageDigest))) return null;
      rec = { ...rec, imageDigest: outcome.imageDigest };
      if (!(await advance(deps.store, rec.id, "Building", "Deploying", "build concluído"))) return null;
    } else if (!(await advance(deps.store, rec.id, "Building", "Deploying"))) {
      return null;
    }
    phase = "Deploying";
  }

  const image = rec.imageDigest;
  if (!image) throw new PermanentError(`deployment ${rec.id} sem image_digest: não é possível convergir`, rec.id);
  const spec = specFor({ ...rec, imageDigest: image });

  if (phase === "Deploying") {
    await deps.runtime.applyWorkload(spec);
    if (!(await advance(deps.store, rec.id, "Deploying", "HealthChecking"))) return null;
  }

  // A partir daqui o deployment está em HealthChecking.
  const status = await deps.runtime.getStatus({ name: spec.name, namespace: spec.namespace });
  if (!isReady(status, spec)) {
    return { kind: "pending", deploymentId: rec.id, reason: "réplicas ainda não estão prontas", phase: "HealthChecking" };
  }
  if (!(await deps.store.promote(rec.id))) return null;
  return { kind: "converged", deploymentId: rec.id };
}

// Logs são diagnóstico: falha ao lê-los não pode mudar o resultado do build.
async function captureBuildLogs(deps: ReconcilerDeps, d: DeploymentRecord): Promise<void> {
  if (!deps.builder) return;
  try {
    await deps.store.saveBuildLog(d.id, await deps.builder.logs({ deploymentId: d.id, serviceInstanceId: d.serviceInstanceId }));
  } catch {
    // Mantém o último retrato salvo.
  }
}

// Inicia (idempotente) e consulta o build de um deployment de repositório.
async function runBuild(deps: ReconcilerDeps, d: DeploymentRecord) {
  if (!deps.builder) throw new PermanentError("builder não configurado para deployment de repositório", d.id);
  if (!d.commitSha || !d.repoUrl) throw new PermanentError(`deployment ${d.id} sem commit ou repositório`, d.id);

  const req: BuildRequest = {
    deploymentId: d.id,
    serviceInstanceId: d.serviceInstanceId,
    repoUrl: d.repoUrl,
    commitSha: d.commitSha,
    rootDir: d.rootDir,
  };
  await deps.builder.start(req);
  return deps.builder.status(req);
}

// Decide o que fazer com um job de reconciliação.
// - Erro permanente: o deployment vai para Failed na hora.
// - Erro transitório: re-tenta até o último retry; nele, o deployment vai para Failed com o motivo.
// - Pendência (build ou health check): re-tenta; no último retry, vai para Failed dizendo em que fase parou.
// `budget` vem do BullMQ, para o orçamento ficar na fila e não em memória.
export async function handleReconcileJob(
  deps: ReconcilerDeps,
  data: { serviceInstanceId: string },
  budget: { attemptsMade: number; maxAttempts: number },
): Promise<ReconcileResult> {
  const lastAttempt = budget.attemptsMade + 1 >= budget.maxAttempts;

  let result: ReconcileResult;
  try {
    result = await reconcileInstance(deps, data.serviceInstanceId);
  } catch (err) {
    const permanent = err instanceof PermanentError;
    if (!permanent && !lastAttempt) throw err;

    const deploymentId = permanent && err.deploymentId ? err.deploymentId : (await deps.store.findActive(data.serviceInstanceId))?.id;
    if (!deploymentId) throw err;

    const reason = permanent ? err.message : `erro após ${budget.maxAttempts} tentativas: ${(err as Error).message}`;
    await failDeployment(deps.store, deploymentId, reason);
    return { kind: "failed", deploymentId };
  }

  if (result.kind !== "pending") return result;

  if (!lastAttempt) {
    throw new Error(`${result.reason} (tentativa ${budget.attemptsMade + 1} de ${budget.maxAttempts})`);
  }
  const what = result.phase === "Building" ? "build não concluiu" : "health check não passou";
  await failDeployment(deps.store, result.deploymentId, `${what} após ${budget.maxAttempts} tentativas: ${result.reason}`);
  return { kind: "failed", deploymentId: result.deploymentId };
}

// Marca o deployment ativo como Failed, a partir do estado em que ele estiver agora.
async function failDeployment(store: DeploymentStore, id: string, reason: string): Promise<void> {
  for (const from of ["HealthChecking", "Deploying", "Building"] as const) {
    transition(from, "Failed");
    if (await store.setStatus(id, from, "Failed", reason)) return;
  }
  throw new Error(`deployment ${id} mudou durante a falha; tentar de novo`);
}

// Valida a transição na máquina de estados antes de gravar. Lança se a transição não existe.
async function advance(
  store: DeploymentStore,
  id: string,
  from: DeploymentStatus,
  to: DeploymentStatus,
  reason?: string,
): Promise<boolean> {
  transition(from, to);
  return store.setStatus(id, from, to, reason);
}

function specFor(d: DeploymentRecord & { imageDigest: string }): WorkloadSpec {
  return {
    name: workloadName(d.serviceInstanceId),
    namespace: namespaceFor(d.environmentId),
    image: d.imageDigest,
    env: d.env,
    replicas: d.replicas,
  };
}

// Pronto = as réplicas da imagem deste deployment estão prontas. Um workload com a imagem antiga não conta.
function isReady(status: WorkloadStatus | null, spec: WorkloadSpec): boolean {
  return status !== null && status.image === spec.image && status.readyReplicas >= spec.replicas;
}
