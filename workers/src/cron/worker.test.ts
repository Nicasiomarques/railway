import type { Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import type { ReconcileJobData } from "@railway-like/shared";
import type { CronStore, TriggerCronResult } from "./store.js";
import { handleCronTriggerJob } from "./worker.js";

function fakeStore(result: TriggerCronResult): CronStore {
  return {
    listCronInstances: async () => [],
    triggerRun: async () => result,
  };
}

describe("handleCronTriggerJob", () => {
  it("re-enqueues a RECONCILE_JOB for the version created by the trigger", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const reconcileQueue = { add } as unknown as Queue<ReconcileJobData>;

    const result = await handleCronTriggerJob(
      { store: fakeStore({ kind: "queued", versionNo: 3 }), reconcileQueue },
      { serviceInstanceId: "instance-a" },
    );

    expect(result).toEqual({ kind: "queued", versionNo: 3 });
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0][1]).toEqual({ serviceInstanceId: "instance-a", versionNo: 3 });
  });

  it("skips without enqueuing when the instance has no previous deployment", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const reconcileQueue = { add } as unknown as Queue<ReconcileJobData>;

    const result = await handleCronTriggerJob(
      { store: fakeStore({ kind: "no_previous_deployment" }), reconcileQueue },
      { serviceInstanceId: "instance-a" },
    );

    expect(result).toEqual({ kind: "skipped", reason: "instance has no previous deployment to re-run yet" });
    expect(add).not.toHaveBeenCalled();
  });

  it("skips without enqueuing when the instance no longer exists", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const reconcileQueue = { add } as unknown as Queue<ReconcileJobData>;

    const result = await handleCronTriggerJob(
      { store: fakeStore({ kind: "instance_not_found" }), reconcileQueue },
      { serviceInstanceId: "instance-a" },
    );

    expect(result).toEqual({ kind: "skipped", reason: "instance not found (likely deleted)" });
    expect(add).not.toHaveBeenCalled();
  });
});
