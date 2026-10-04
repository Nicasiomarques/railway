// What the decommission worker needs from Postgres. Mirrors the provisioning saga's
// EnvironmentProvisioningStore (../provisioning/saga.ts): the minimal read/write needed to safely
// tear an environment down.

export interface DecommissionEnvironmentRecord {
  id: string;
  projectId: string;
  // Never null for a row listExpired/findEnvironment returns as due: callers still re-check it
  // (see decommissionEnvironment) in case it moved after the sweep enqueued the job.
  ttlAt: Date | null;
}

export interface DecommissionStore {
  // Environments with ttl_at in the past, not already deleted. Drives the periodic sweep
  // (workers/src/decommission/worker.ts).
  listExpired(now: Date): Promise<DecommissionEnvironmentRecord[]>;
  findEnvironment(environmentId: string): Promise<DecommissionEnvironmentRecord | null>;
  // Live (not already deleted) service instances in the environment.
  listServiceInstanceIds(environmentId: string): Promise<string[]>;
  // Domains have no soft-delete column (db/src/schema.ts): a released hostname is simply removed.
  deleteDomains(serviceInstanceId: string): Promise<void>;
  markServiceInstanceDeleted(serviceInstanceId: string): Promise<void>;
  markEnvironmentDeleted(environmentId: string): Promise<void>;
}
