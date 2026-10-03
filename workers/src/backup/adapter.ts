// Backup/restore provider port (architecture.md §6): "Stateful (Postgres/Redis/volumes): PVC +
// scheduled backup (volume snapshot + logical dump) to object storage; restore is an explicit,
// audited operation." Only the backup worker calls this interface. Implementations:
// InMemoryBackupProvider (tests and environments without real infra). A real implementation
// (volume snapshot and/or `pg_dump`/`redis-cli --rdb` piped to object storage) comes later, behind
// this same port.

export type BackupStatus = "completed" | "failed";

export interface BackupResult {
  status: BackupStatus;
  // Human-readable reason when status is "failed"; null otherwise.
  reason: string | null;
}

export interface BackupProvider {
  // Takes a snapshot of the volume (or a logical dump, for the Postgres/Redis templates) and ships
  // it to object storage. Each call represents one backup attempt; it isn't expected to be polled
  // like certificate issuance — it either completes or fails.
  runBackup(volumeId: string): Promise<BackupResult>;

  // Restores the volume from the most recent backup in object storage. Always an explicit,
  // audited operation (architecture.md §6): never triggered automatically by the worker, and never
  // called from the daily schedule.
  restoreBackup(volumeId: string): Promise<BackupResult>;
}
