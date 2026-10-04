import type { Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import type { DecommissionEnvironmentJobData } from "@railway-like/shared";
import { InMemoryRuntime } from "../runtime/in-memory.js";
import { InMemoryDecommissionStore } from "./in-memory-store.js";
import { enqueueDecommission, sweepExpiredEnvironments } from "./worker.js";

describe("enqueueDecommission", () => {
  it("adds one job with a stable, per-environment id", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const fakeQueue = { add } as unknown as Queue<DecommissionEnvironmentJobData>;

    await enqueueDecommission(fakeQueue, { environmentId: "env-1" });

    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0][1]).toEqual({ environmentId: "env-1" });
    expect(add.mock.calls[0][2]).toMatchObject({ jobId: "decommission-env-1" });
  });
});

describe("sweepExpiredEnvironments", () => {
  it("without a queue wired, is a no-op rather than a crash", async () => {
    const store = new InMemoryDecommissionStore();
    const runtime = new InMemoryRuntime();

    expect(await sweepExpiredEnvironments({ store, runtime })).toEqual({ kind: "skipped" });
  });

  it("re-enqueues one decommission job per expired environment, and none for a live one", async () => {
    const store = new InMemoryDecommissionStore();
    store.addEnvironment({ id: "env-expired", projectId: "proj-1", ttlAt: new Date(Date.now() - 1000) });
    store.addEnvironment({ id: "env-live", projectId: "proj-1", ttlAt: new Date(Date.now() + 60_000) });
    store.addEnvironment({ id: "env-no-ttl", projectId: "proj-1", ttlAt: null });
    const runtime = new InMemoryRuntime();
    const add = vi.fn().mockResolvedValue(undefined);
    const queue = { add } as unknown as Queue<DecommissionEnvironmentJobData>;

    const result = await sweepExpiredEnvironments({ store, runtime, queue });

    expect(result).toEqual({ kind: "scheduled", count: 1 });
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0][1]).toEqual({ environmentId: "env-expired" });
  });
});
