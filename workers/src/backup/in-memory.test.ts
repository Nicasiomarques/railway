import { describe, expect, it } from "vitest";
import { InMemoryBackupProvider } from "./in-memory.js";

const VOLUME_ID = "vol-1";

describe("InMemoryBackupProvider", () => {
  it("runBackup completes by default", async () => {
    const provider = new InMemoryBackupProvider();
    expect(await provider.runBackup(VOLUME_ID)).toEqual({ status: "completed", reason: null });
  });

  it("restoreBackup completes by default", async () => {
    const provider = new InMemoryBackupProvider();
    expect(await provider.restoreBackup(VOLUME_ID)).toEqual({ status: "completed", reason: null });
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
});
