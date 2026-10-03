import type { ObjectStorageProvider } from "../storage/adapter.js";
import { InMemoryObjectStorageProvider } from "../storage/in-memory.js";
import type { BackupProvider, BackupResult } from "./adapter.js";

function dumpKey(volumeId: string): string {
  return `backups/${volumeId}/dump.json`;
}

// Simulates the real flow (snapshot/dump -> object storage): no real volume snapshot or
// `pg_dump`/`redis-cli --rdb`, but runBackup writes a small JSON "dump" (volumeId + timestamp)
// through a real ObjectStorageProvider port, and restoreBackup reads it back. Defaults to an
// in-memory storage provider so existing `new InMemoryBackupProvider()` call sites keep working
// without a real backend; pass a LocalFsObjectStorageProvider (or a future S3/GCS one) to back it
// with real storage.
export class InMemoryBackupProvider implements BackupProvider {
  private readonly forcedFailures = new Map<string, string>();

  constructor(private readonly storage: ObjectStorageProvider = new InMemoryObjectStorageProvider()) {}

  async runBackup(volumeId: string): Promise<BackupResult> {
    const forced = this.forcedResult(volumeId);
    if (forced) return forced;

    const dump = { volumeId, timestamp: new Date().toISOString() };
    await this.storage.put(dumpKey(volumeId), JSON.stringify(dump));
    return { status: "completed", reason: null };
  }

  async restoreBackup(volumeId: string): Promise<BackupResult> {
    const forced = this.forcedResult(volumeId);
    if (forced) return forced;

    const data = await this.storage.get(dumpKey(volumeId));
    if (!data) {
      return { status: "failed", reason: `no backup found in object storage for volume ${volumeId}` };
    }
    return { status: "completed", reason: null };
  }

  private forcedResult(volumeId: string): BackupResult | null {
    const reason = this.forcedFailures.get(volumeId);
    return reason ? { status: "failed", reason } : null;
  }

  // Tests: forces the next call(s) for this volume to fail, as if storage were unreachable.
  markFailing(volumeId: string, reason = "simulated storage failure"): void {
    this.forcedFailures.set(volumeId, reason);
  }

  // Tests: undoes markFailing, so a later attempt for the same volume can succeed.
  clearFailing(volumeId: string): void {
    this.forcedFailures.delete(volumeId);
  }
}
