// What the domain worker needs from Postgres. Mirrors the reconciler's DeploymentStore
// (reconciler/store.ts): the minimal read/write needed for the worker to safely advance state.
export interface DomainRecord {
  id: string;
  hostname: string;
  tlsState: string;
}

export interface DomainStore {
  get(id: string): Promise<DomainRecord | null>;

  // Compare-and-set: writes `to` only if the current state is still `from`. Returns false on a race.
  setTlsState(id: string, from: string, to: string): Promise<boolean>;
}
