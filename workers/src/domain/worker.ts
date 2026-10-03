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

// Constants and contract come from @railway-like/shared: the API produces jobs with the same rules.
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

// Advances the domain through the DNS → ACME → edge flow (architecture.md §6 and §8). Idempotent:
// calling it again with the domain already "issued" doesn't hit the provider again.
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
    return { kind: "failed", reason: result.reason ?? "issuance failed" };
  }
  return { kind: "pending", reason: "waiting for DNS/ACME validation" };
}

// Decides what to do with a job: a pending result retries until the budget runs out; on the last
// retry, the domain goes to "failed" with the reason. `budget` comes from BullMQ, keeping the budget on the queue.
export async function handleIssueCertificateJob(
  deps: DomainWorkerDeps,
  data: IssueCertificateJobData,
  budget: { attemptsMade: number; maxAttempts: number },
): Promise<ProcessDomainResult> {
  const result = await processDomain(deps, data.domainId);
  if (result.kind !== "pending") return result;

  const lastAttempt = budget.attemptsMade + 1 >= budget.maxAttempts;
  if (!lastAttempt) {
    throw new Error(`${result.reason} (attempt ${budget.attemptsMade + 1} of ${budget.maxAttempts})`);
  }
  await deps.store.setTlsState(data.domainId, "pending", "failed");
  return { kind: "failed", reason: `tls did not issue after ${budget.maxAttempts} attempts: ${result.reason}` };
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
