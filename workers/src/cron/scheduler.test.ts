import type { Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import type { CronTriggerJobData } from "@railway-like/shared";
import { CRON_TRIGGER_JOB, registerCronSchedules } from "./scheduler.js";

describe("registerCronSchedules", () => {
  it("registers one repeatable job per instance, with its own cron expression as the pattern", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const fakeQueue = { add } as unknown as Queue<CronTriggerJobData>;

    await registerCronSchedules(fakeQueue, [
      { serviceInstanceId: "instance-a", schedule: "0 3 * * *" },
      { serviceInstanceId: "instance-b", schedule: "*/15 * * * *" },
    ]);

    expect(add).toHaveBeenCalledTimes(2);

    const [nameA, dataA, optsA] = add.mock.calls[0];
    expect(nameA).toBe(CRON_TRIGGER_JOB);
    expect(dataA).toEqual({ serviceInstanceId: "instance-a" });
    expect(optsA.repeat).toEqual({ pattern: "0 3 * * *" });
    expect(optsA.jobId).toBe("cron-trigger-instance-a");

    const [, dataB, optsB] = add.mock.calls[1];
    expect(dataB).toEqual({ serviceInstanceId: "instance-b" });
    expect(optsB.repeat).toEqual({ pattern: "*/15 * * * *" });
    expect(optsB.jobId).toBe("cron-trigger-instance-b");
  });

  it("uses a stable, per-instance jobId so re-registering the same instance replaces its repeat rule", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const fakeQueue = { add } as unknown as Queue<CronTriggerJobData>;

    const instance = { serviceInstanceId: "instance-a", schedule: "0 3 * * *" };
    await registerCronSchedules(fakeQueue, [instance]);
    await registerCronSchedules(fakeQueue, [instance]);

    expect(add).toHaveBeenCalledTimes(2);
    const [, , firstOpts] = add.mock.calls[0];
    const [, , secondOpts] = add.mock.calls[1];
    expect(firstOpts.jobId).toBe(secondOpts.jobId);
  });

  it("does nothing when there are no cron instances", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const fakeQueue = { add } as unknown as Queue<CronTriggerJobData>;

    await registerCronSchedules(fakeQueue, []);

    expect(add).not.toHaveBeenCalled();
  });
});
