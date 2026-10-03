import type { BackupProvider, BackupResult } from "./adapter.js";

// Simulates the real flow (snapshot/dump -> object storage) with no external calls: succeeds
// unless the test has armed a failure for that volume.
export class InMemoryBackupProvider implements BackupProvider {
  private readonly forcedFailures = new Map<string, string>();

  async runBackup(volumeId: string): Promise<BackupResult> {
    return this.result(volumeId);
  }

  async restoreBackup(volumeId: string): Promise<BackupResult> {
    return this.result(volumeId);
  }

  private result(volumeId: string): BackupResult {
    const reason = this.forcedFailures.get(volumeId);
    return reason ? { status: "failed", reason } : { status: "completed", reason: null };
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
