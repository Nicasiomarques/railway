import type { Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import type { SampleUsageJobData } from "@railway-like/shared";
import { workloadName } from "../runtime/adapter.js";
import { InMemoryRuntime } from "../runtime/in-memory.js";
import { InMemoryUsageStore } from "./in-memory-store.js";
import { enqueueUsageSamplingTick, handleSampleUsageJob } from "./worker.js";

const INSTANCE_ID = "inst-1";
const PROJECT_ID = "proj-1";
const ENVIRONMENT_ID = "env-1";

function setup() {
  const store = new InMemoryUsageStore();
  store.add({ id: INSTANCE_ID, projectId: PROJECT_ID, environmentId: ENVIRONMENT_ID });
  const runtime = new InMemoryRuntime();
  return { store, runtime, deps: { store, runtime } };
}

describe("handleSampleUsageJob", () => {
  it("a nonexistent instance returns not_found", async () => {
    const { deps } = setup();
    expect(await handleSampleUsageJob(deps, { serviceInstanceId: "other-id" })).toEqual({ kind: "not_found" });
    expect(deps.store.samples).toHaveLength(0);
  });

  it("an instance with no running workload returns no_workload and writes nothing", async () => {
    const { deps } = setup();
    expect(await handleSampleUsageJob(deps, { serviceInstanceId: INSTANCE_ID })).toEqual({ kind: "no_workload" });
    expect(deps.store.samples).toHaveLength(0);
  });

  it("records one replica_minutes row with the instance's current replica count", async () => {
    const { deps, runtime } = setup();
    await runtime.applyWorkload({ name: workloadName(INSTANCE_ID), namespace: `env-${ENVIRONMENT_ID}`, image: "img@sha256:a", env: {}, replicas: 3 });

    const result = await handleSampleUsageJob(deps, { serviceInstanceId: INSTANCE_ID });

    expect(result).toEqual({ kind: "recorded", replicas: 3 });
    expect(deps.store.samples).toHaveLength(1);
    expect(deps.store.samples[0]).toMatchObject({
      projectId: PROJECT_ID,
      serviceInstanceId: INSTANCE_ID,
      metric: "replica_minutes",
      value: 3,
    });
    expect(deps.store.samples[0].occurredAt).toBeInstanceOf(Date);
  });

  it("scales the recorded value by the configured sample interval", async () => {
    const { store, runtime } = setup();
    await runtime.applyWorkload({ name: workloadName(INSTANCE_ID), namespace: `env-${ENVIRONMENT_ID}`, image: "img@sha256:a", env: {}, replicas: 2 });
    const deps = { store, runtime, sampleIntervalMinutes: 5 };

    await handleSampleUsageJob(deps, { serviceInstanceId: INSTANCE_ID });

    expect(store.samples[0].value).toBe(10);
  });

  it("can sample the same instance again later, appending a new row", async () => {
    const { deps, runtime } = setup();
    await runtime.applyWorkload({ name: workloadName(INSTANCE_ID), namespace: `env-${ENVIRONMENT_ID}`, image: "img@sha256:a", env: {}, replicas: 1 });

    await handleSampleUsageJob(deps, { serviceInstanceId: INSTANCE_ID });
    await handleSampleUsageJob(deps, { serviceInstanceId: INSTANCE_ID });

    expect(deps.store.samples).toHaveLength(2);
  });
});

describe("enqueueUsageSamplingTick", () => {
  it("fans out one sample-usage job per instance id", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const fakeQueue = { add } as unknown as Queue<SampleUsageJobData>;

    await enqueueUsageSamplingTick(fakeQueue, ["inst-a", "inst-b", "inst-c"]);

    expect(add).toHaveBeenCalledTimes(3);
    expect(add.mock.calls[0][1]).toEqual({ serviceInstanceId: "inst-a" });
    expect(add.mock.calls[1][1]).toEqual({ serviceInstanceId: "inst-b" });
    expect(add.mock.calls[2][1]).toEqual({ serviceInstanceId: "inst-c" });
  });

  it("enqueues nothing for an empty instance list", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const fakeQueue = { add } as unknown as Queue<SampleUsageJobData>;

    await enqueueUsageSamplingTick(fakeQueue, []);

    expect(add).not.toHaveBeenCalled();
  });
});
