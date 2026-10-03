// Contract for deployment jobs between the API (producer) and workers (consumers).
// No runtime dependencies: can be imported from any package.

export const DEPLOYMENTS_QUEUE = "deployments";
export const RECONCILE_JOB = "reconcile-instance";

export interface ReconcileJobData {
  serviceInstanceId: string;
  versionNo: number;
}

// Pending states (build in progress, replicas not yet ready) re-enqueue at a fixed interval:
// exponential backoff would let completion detection lag by several minutes.
// 240 attempts × 5s ≈ 20 min budget.
export const RECONCILE_JOB_RETRY = {
  attempts: 240,
  backoff: { type: "fixed", delay: 5000 },
  removeOnComplete: true,
  removeOnFail: 100,
} as const;

// One job per version: re-enqueuing the same version doesn't duplicate work, and a new
// version never gets stuck behind another version's active job.
export function reconcileJobId(data: ReconcileJobData): string {
  return `reconcile-${data.serviceInstanceId}-v${data.versionNo}`;
}

// Job that deletes the build Job of a cancelled deployment. Goes in the same queue; the worker picks it up by name.
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

// Environment provisioning saga (architecture.md §6): namespace, NetworkPolicy and quotas.
// Goes in the same queue; the worker picks it up by job name. One job per environment: re-enqueuing doesn't duplicate the saga.
export const PROVISION_ENVIRONMENT_JOB = "provision-environment";

export interface ProvisionEnvironmentJobData {
  environmentId: string;
}

export function provisionEnvironmentJobId(data: ProvisionEnvironmentJobData): string {
  return `provision-${data.environmentId}`;
}

// Steps with a transient failure (cluster API unavailable) are retried; the state of already-completed steps is preserved.
export const PROVISION_ENVIRONMENT_JOB_RETRY = {
  attempts: 10,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: true,
  removeOnFail: 100,
} as const;

// Domain/TLS (architecture.md §6 and §8): hostname → DNS → ACME certificate → edge route.
// Own queue: a domain's lifecycle has no relation to a deployment's.
export const DOMAINS_QUEUE = "domains";
export const ISSUE_CERTIFICATE_JOB = "issue-certificate";

export interface IssueCertificateJobData {
  domainId: string;
}

// One job per domain: re-enqueueing the same domain doesn't duplicate the work.
export function issueCertificateJobId(data: IssueCertificateJobData): string {
  return `issue-certificate-${data.domainId}`;
}

// Pending (DNS still propagating, ACME still validating) isn't an error: retry at a fixed interval.
// 60 attempts × 5s = 5 min budget before marking the domain as "failed".
export const ISSUE_CERTIFICATE_JOB_RETRY = {
  attempts: 60,
  backoff: { type: "fixed", delay: 5000 },
  removeOnComplete: true,
  removeOnFail: 100,
} as const;
