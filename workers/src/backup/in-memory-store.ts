import type { BackupStore, VolumeRecord } from "./store.js";

// In-memory store for tests. Mirrors the Postgres contract, including setBackupState's compare-and-set.
export class InMemoryBackupStore implements BackupStore {
  private readonly rows = new Map<string, VolumeRecord>();

  add(record: VolumeRecord): void {
    this.rows.set(record.id, { ...record });
  }

  async get(id: string): Promise<VolumeRecord | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async setBackupState(id: string, from: string, to: string, lastBackupAt?: Date | null): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.backupState !== from) return false;
    row.backupState = to;
    if (lastBackupAt !== undefined) row.lastBackupAt = lastBackupAt;
    return true;
  }
}
