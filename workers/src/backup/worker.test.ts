import type { Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import type { RunBackupJobData } from "@railway-like/shared";
import { InMemoryBackupProvider } from "./in-memory.js";
import { InMemoryBackupStore } from "./in-memory-store.js";
import { enqueueDailyBackup, handleRestoreBackupJob, handleRunBackupJob, processBackup, processRestore } from "./worker.js";

const VOLUME_ID = "vol-1";

function setup() {
  const store = new InMemoryBackupStore();
  store.add({ id: VOLUME_ID, backupState: "none", lastBackupAt: null });
  const provider = new InMemoryBackupProvider();
  return { store, provider, deps: { store, provider } };
}

describe("processBackup", () => {
  it("a nonexistent volume returns not_found", async () => {
    const { deps } = setup();
    expect(await processBackup(deps, "other-id")).toEqual({ kind: "not_found" });
  });

  it("completes and writes backup_state=completed with lastBackupAt when the provider confirms", async () => {
    const { deps, store } = setup();

    expect(await processBackup(deps, VOLUME_ID)).toEqual({ kind: "completed" });
    const row = await store.get(VOLUME_ID);
    expect(row!.backupState).toBe("completed");
    expect(row!.lastBackupAt).toBeInstanceOf(Date);
  });

  it("marks the volume pending while the attempt runs", async () => {
    const { store, provider } = setup();
    const deps = { store, provider };
    // Observes the state mid-flight by making the provider read the store before resolving.
    let pendingDuringCall: string | undefined;
    const originalRunBackup = provider.runBackup.bind(provider);
    provider.runBackup = async (id: string) => {
      pendingDuringCall = (await store.get(VOLUME_ID))!.backupState;
      return originalRunBackup(id);
    };

    await processBackup(deps, VOLUME_ID);
    expect(pendingDuringCall).toBe("pending");
  });

  it("a provider failure returns failed without writing it as final yet", async () => {
    const { deps, store, provider } = setup();
    provider.markFailing(VOLUME_ID, "object storage unreachable");

    expect(await processBackup(deps, VOLUME_ID)).toEqual({ kind: "failed", reason: "object storage unreachable" });
    // Left "pending": handleRunBackupJob decides whether this is final (see below).
    expect((await store.get(VOLUME_ID))!.backupState).toBe("pending");
  });

  it("can run again for a volume that already completed a backup", async () => {
    const { deps, store } = setup();
    await processBackup(deps, VOLUME_ID);

    expect(await processBackup(deps, VOLUME_ID)).toEqual({ kind: "completed" });
    expect((await store.get(VOLUME_ID))!.backupState).toBe("completed");
  });
});

describe("handleRunBackupJob", () => {
  it("a failure with budget left throws an error for BullMQ to retry", async () => {
    const { deps, store, provider } = setup();
    provider.markFailing(VOLUME_ID, "object storage unreachable");

    await expect(
      handleRunBackupJob(deps, { volumeId: VOLUME_ID }, { attemptsMade: 0, maxAttempts: 5 }),
    ).rejects.toThrow(/attempt 1 of 5/);
    expect((await store.get(VOLUME_ID))!.backupState).toBe("pending");
  });

  it("on the last attempt without completing, the volume goes to failed", async () => {
    const { deps, store, provider } = setup();
    provider.markFailing(VOLUME_ID, "object storage unreachable");

    const result = await handleRunBackupJob(deps, { volumeId: VOLUME_ID }, { attemptsMade: 4, maxAttempts: 5 });

    expect(result.kind).toBe("failed");
    expect((await store.get(VOLUME_ID))!.backupState).toBe("failed");
  });

  it("completes within budget, without needing the last attempt", async () => {
    const { deps, store } = setup();

    const result = await handleRunBackupJob(deps, { volumeId: VOLUME_ID }, { attemptsMade: 0, maxAttempts: 5 });

    expect(result).toEqual({ kind: "completed" });
    expect((await store.get(VOLUME_ID))!.backupState).toBe("completed");
  });

  it("a volume that previously failed can complete on a later run", async () => {
    const { deps, store, provider } = setup();
    provider.markFailing(VOLUME_ID);
    await handleRunBackupJob(deps, { volumeId: VOLUME_ID }, { attemptsMade: 0, maxAttempts: 1 });
    expect((await store.get(VOLUME_ID))!.backupState).toBe("failed");

    provider.clearFailing(VOLUME_ID);
    const result = await handleRunBackupJob(deps, { volumeId: VOLUME_ID }, { attemptsMade: 0, maxAttempts: 1 });

    expect(result).toEqual({ kind: "completed" });
    expect((await store.get(VOLUME_ID))!.backupState).toBe("completed");
  });
});

// Phase 3 (docs/roadmap.md): "Backup restore testing" — a restore that isn't exercised against
// both outcomes (a real prior backup, and none at all) is exactly how "we have backups" turns out
// not to mean "we can restore from them" during a real incident. See docs/runbooks/.
describe("processRestore", () => {
  it("a nonexistent volume returns not_found", async () => {
    const { deps } = setup();
    expect(await processRestore(deps, "other-id")).toEqual({ kind: "not_found" });
  });

  it("fails cleanly when the volume has never been backed up", async () => {
    const { deps, store } = setup();

    const result = await processRestore(deps, VOLUME_ID);

    expect(result.kind).toBe("failed");
    expect(result).toMatchObject({ reason: expect.stringContaining("no backup found") });
    // Left "pending": handleRestoreBackupJob decides whether this is final.
    expect((await store.get(VOLUME_ID))!.backupState).toBe("pending");
  });

  it("restores successfully from a volume's own prior backup", async () => {
    const { deps, store } = setup();
    await processBackup(deps, VOLUME_ID);

    const result = await processRestore(deps, VOLUME_ID);

    expect(result).toEqual({ kind: "completed" });
    expect((await store.get(VOLUME_ID))!.backupState).toBe("completed");
  });

  it("a provider failure returns failed without writing it as final yet", async () => {
    const { deps, store, provider } = setup();
    await processBackup(deps, VOLUME_ID);
    provider.markFailing(VOLUME_ID, "object storage unreachable");

    expect(await processRestore(deps, VOLUME_ID)).toEqual({ kind: "failed", reason: "object storage unreachable" });
    expect((await store.get(VOLUME_ID))!.backupState).toBe("pending");
  });
});

describe("handleRestoreBackupJob", () => {
  it("a failure with budget left throws an error for BullMQ to retry", async () => {
    const { deps, store } = setup(); // never backed up: the provider fails restoreBackup on its own.

    await expect(
      handleRestoreBackupJob(deps, { volumeId: VOLUME_ID }, { attemptsMade: 0, maxAttempts: 5 }),
    ).rejects.toThrow(/attempt 1 of 5/);
    expect((await store.get(VOLUME_ID))!.backupState).toBe("pending");
  });

  it("on the last attempt without completing, the volume goes to failed", async () => {
    const { deps, store } = setup();

    const result = await handleRestoreBackupJob(deps, { volumeId: VOLUME_ID }, { attemptsMade: 4, maxAttempts: 5 });

    expect(result.kind).toBe("failed");
    expect((await store.get(VOLUME_ID))!.backupState).toBe("failed");
  });

  it("completes within budget when a prior backup exists", async () => {
    const { deps, store } = setup();
    await processBackup(deps, VOLUME_ID);

    const result = await handleRestoreBackupJob(deps, { volumeId: VOLUME_ID }, { attemptsMade: 0, maxAttempts: 5 });

    expect(result).toEqual({ kind: "completed" });
    expect((await store.get(VOLUME_ID))!.backupState).toBe("completed");
  });
});

describe("enqueueDailyBackup", () => {
  it("fans out one run-backup job per volume id", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const fakeQueue = { add } as unknown as Queue<RunBackupJobData>;

    await enqueueDailyBackup(fakeQueue, ["vol-a", "vol-b"]);

    expect(add).toHaveBeenCalledTimes(2);
    expect(add.mock.calls[0][1]).toEqual({ volumeId: "vol-a" });
    expect(add.mock.calls[1][1]).toEqual({ volumeId: "vol-b" });
  });
});
