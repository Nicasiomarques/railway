import { describe, expect, it } from "vitest";
import { InMemoryObjectStorageProvider } from "../storage/in-memory.js";
import { InMemoryBackupProvider } from "./in-memory.js";

const VOLUME_ID = "vol-1";

describe("InMemoryBackupProvider", () => {
  it("runBackup completes by default", async () => {
    const provider = new InMemoryBackupProvider();
    expect(await provider.runBackup(VOLUME_ID)).toEqual({ status: "completed", reason: null });
  });

  it("restoreBackup completes after a prior runBackup wrote a dump to storage", async () => {
    const provider = new InMemoryBackupProvider();
    await provider.runBackup(VOLUME_ID);
    expect(await provider.restoreBackup(VOLUME_ID)).toEqual({ status: "completed", reason: null });
  });

  it("restoreBackup fails by default when no backup was ever taken for the volume", async () => {
    const provider = new InMemoryBackupProvider();
    const result = await provider.restoreBackup(VOLUME_ID);
    expect(result.status).toBe("failed");
    expect(result.reason).not.toBeNull();
  });

  it("markFailing forces both runBackup and restoreBackup to fail with the given reason", async () => {
    const provider = new InMemoryBackupProvider();
    provider.markFailing(VOLUME_ID, "object storage unreachable");

    expect(await provider.runBackup(VOLUME_ID)).toEqual({ status: "failed", reason: "object storage unreachable" });
    expect(await provider.restoreBackup(VOLUME_ID)).toEqual({ status: "failed", reason: "object storage unreachable" });
  });

  it("clearFailing lets a later attempt for the same volume complete", async () => {
    const provider = new InMemoryBackupProvider();
    provider.markFailing(VOLUME_ID);
    provider.clearFailing(VOLUME_ID);

    expect(await provider.runBackup(VOLUME_ID)).toEqual({ status: "completed", reason: null });
  });

  it("a forced failure only affects the volume it was armed for", async () => {
    const provider = new InMemoryBackupProvider();
    provider.markFailing(VOLUME_ID);

    expect(await provider.runBackup("other-volume")).toEqual({ status: "completed", reason: null });
  });

  describe("object storage flow", () => {
    it("runBackup writes a dump (volumeId + timestamp) to the injected storage provider", async () => {
      const storage = new InMemoryObjectStorageProvider();
      const provider = new InMemoryBackupProvider(storage);

      expect(await storage.exists(`backups/${VOLUME_ID}/dump.json`)).toBe(false);

      const result = await provider.runBackup(VOLUME_ID);
      expect(result).toEqual({ status: "completed", reason: null });

      const raw = await storage.get(`backups/${VOLUME_ID}/dump.json`);
      expect(raw).not.toBeNull();
      const dump = JSON.parse(raw!.toString("utf8"));
      expect(dump.volumeId).toBe(VOLUME_ID);
      expect(typeof dump.timestamp).toBe("string");
      expect(new Date(dump.timestamp).toString()).not.toBe("Invalid Date");
    });

    it("restoreBackup succeeds after runBackup wrote a dump", async () => {
      const storage = new InMemoryObjectStorageProvider();
      const provider = new InMemoryBackupProvider(storage);

      await provider.runBackup(VOLUME_ID);
      expect(await provider.restoreBackup(VOLUME_ID)).toEqual({ status: "completed", reason: null });
    });

    it("restoreBackup fails with a clear reason when there is no backup in storage", async () => {
      const storage = new InMemoryObjectStorageProvider();
      const provider = new InMemoryBackupProvider(storage);

      const result = await provider.restoreBackup(VOLUME_ID);
      expect(result.status).toBe("failed");
      expect(result.reason).toMatch(new RegExp(VOLUME_ID));
    });

    it("defaults to its own InMemoryObjectStorageProvider when none is injected", async () => {
      const provider = new InMemoryBackupProvider();

      await provider.runBackup(VOLUME_ID);
      expect(await provider.restoreBackup(VOLUME_ID)).toEqual({ status: "completed", reason: null });
    });

    it("markFailing takes priority over storage, even when a real dump exists", async () => {
      const storage = new InMemoryObjectStorageProvider();
      const provider = new InMemoryBackupProvider(storage);

      await provider.runBackup(VOLUME_ID);
      provider.markFailing(VOLUME_ID, "simulated outage");

      expect(await provider.restoreBackup(VOLUME_ID)).toEqual({ status: "failed", reason: "simulated outage" });
    });
  });
});
