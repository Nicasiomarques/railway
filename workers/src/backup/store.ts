// What the backup worker needs from Postgres. Mirrors the domain worker's DomainStore
// (domain/store.ts): the minimal read/write needed for the worker to safely advance state.
export interface VolumeRecord {
  id: string;
  backupState: string;
  lastBackupAt: Date | null;
}

export interface BackupStore {
  get(id: string): Promise<VolumeRecord | null>;

  // Compare-and-set: writes `to` (and lastBackupAt, when given) only if the current state is
  // still `from`. Returns false on a race.
  setBackupState(id: string, from: string, to: string, lastBackupAt?: Date | null): Promise<boolean>;
}
