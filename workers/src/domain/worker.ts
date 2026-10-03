import { Queue, Worker, type ConnectionOptions, type JobsOptions } from "bullmq";
import {
  DOMAINS_QUEUE,
  ISSUE_CERTIFICATE_JOB,
  ISSUE_CERTIFICATE_JOB_RETRY,
  issueCertificateJobId,
  type IssueCertificateJobData,
} from "@railway-like/shared";
import type { DomainProvider } from "./adapter.js";
import type { DomainStore } from "./store.js";

// Constantes e contrato vêm de @railway-like/shared: a API produz os jobs com as mesmas regras.
export { DOMAINS_QUEUE, ISSUE_CERTIFICATE_JOB, type IssueCertificateJobData };

export const ISSUE_CERTIFICATE_JOB_OPTIONS: JobsOptions = ISSUE_CERTIFICATE_JOB_RETRY;

export async function enqueueIssueCertificate(
  queue: Queue<IssueCertificateJobData>,
  data: IssueCertificateJobData,
): Promise<void> {
  await queue.add(ISSUE_CERTIFICATE_JOB, data, { ...ISSUE_CERTIFICATE_JOB_OPTIONS, jobId: issueCertificateJobId(data) });
}

export interface DomainWorkerDeps {
  store: DomainStore;
  provider: DomainProvider;
}

export type ProcessDomainResult =
  | { kind: "issued" }
  | { kind: "pending"; reason: string }
  | { kind: "failed"; reason: string }
  | { kind: "not_found" };

// Avança o domínio no fluxo DNS → ACME → edge (architecture.md §6 e §8). Idempotente: chamar de novo
// com o domínio já "issued" não bate no provider outra vez.
export async function processDomain(deps: DomainWorkerDeps, domainId: string): Promise<ProcessDomainResult> {
  const domain = await deps.store.get(domainId);
  if (!domain) return { kind: "not_found" };
  if (domain.tlsState === "issued") return { kind: "issued" };

  const result = await deps.provider.issueCertificate(domain.hostname);
  if (result.status === "issued") {
    await deps.store.setTlsState(domain.id, domain.tlsState, "issued");
    return { kind: "issued" };
  }
  if (result.status === "failed") {
    await deps.store.setTlsState(domain.id, domain.tlsState, "failed");
    return { kind: "failed", reason: result.reason ?? "emissão falhou" };
  }
  return { kind: "pending", reason: "aguardando validação de DNS/ACME" };
}

// Decide o que fazer com um job: pendência re-tenta até o orçamento acabar; no último retry,
// o domínio vai para "failed" com o motivo. `budget` vem do BullMQ, para o orçamento ficar na fila.
export async function handleIssueCertificateJob(
  deps: DomainWorkerDeps,
  data: IssueCertificateJobData,
  budget: { attemptsMade: number; maxAttempts: number },
): Promise<ProcessDomainResult> {
  const result = await processDomain(deps, data.domainId);
  if (result.kind !== "pending") return result;

  const lastAttempt = budget.attemptsMade + 1 >= budget.maxAttempts;
  if (!lastAttempt) {
    throw new Error(`${result.reason} (tentativa ${budget.attemptsMade + 1} de ${budget.maxAttempts})`);
  }
  await deps.store.setTlsState(data.domainId, "pending", "failed");
  return { kind: "failed", reason: `tls não emitiu após ${budget.maxAttempts} tentativas: ${result.reason}` };
}

export function createDomainWorker(connection: ConnectionOptions, deps: DomainWorkerDeps): Worker<IssueCertificateJobData> {
  return new Worker<IssueCertificateJobData>(
    DOMAINS_QUEUE,
    async (job) =>
      handleIssueCertificateJob(deps, job.data, {
        attemptsMade: job.attemptsMade,
        maxAttempts: job.opts.attempts ?? 1,
      }),
    { connection },
  );
}
