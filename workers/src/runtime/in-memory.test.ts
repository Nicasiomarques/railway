import { describe, expect, it } from "vitest";
import { InMemoryRuntime } from "./in-memory.js";

const REF = { name: "wl-1", namespace: "env-ns" };
const spec = { name: "wl-1", namespace: "env-ns", image: "app@sha256:aaa", env: { A: "1", B: "2" }, replicas: 1 };

describe("InMemoryRuntime", () => {
  it("applying the same spec again keeps the replicas ready", async () => {
    const runtime = new InMemoryRuntime();
    await runtime.applyWorkload(spec);
    runtime.markReady("wl-1");

    await runtime.applyWorkload({ ...spec, env: { B: "2", A: "1" } });

    expect(await runtime.getStatus(REF)).toMatchObject({ readyReplicas: 1 });
  });

  it("changing the image starts a rollout with no ready replicas", async () => {
    const runtime = new InMemoryRuntime();
    await runtime.applyWorkload(spec);
    runtime.markReady("wl-1");

    await runtime.applyWorkload({ ...spec, image: "app@sha256:bbb" });

    expect(await runtime.getStatus(REF)).toEqual({ image: "app@sha256:bbb", replicas: 1, readyReplicas: 0 });
  });

  it("nonexistent workload returns null", async () => {
    expect(await new InMemoryRuntime().getStatus({ name: "nope", namespace: "env-ns" })).toBeNull();
  });
});

describe("deleteNamespace", () => {
  it("removes every workload applied under the namespace", async () => {
    const runtime = new InMemoryRuntime();
    await runtime.applyWorkload(spec);
    await runtime.applyWorkload({ ...spec, name: "wl-2" });

    await runtime.deleteNamespace("env-ns");

    expect(await runtime.getStatus(REF)).toBeNull();
    expect(await runtime.getStatus({ name: "wl-2", namespace: "env-ns" })).toBeNull();
  });

  it("doesn't touch a workload in a different namespace", async () => {
    const runtime = new InMemoryRuntime();
    await runtime.applyWorkload(spec);
    await runtime.applyWorkload({ ...spec, name: "wl-other", namespace: "env-other" });

    await runtime.deleteNamespace("env-ns");

    expect(await runtime.getStatus({ name: "wl-other", namespace: "env-other" })).not.toBeNull();
  });

  it("an already-gone namespace is a no-op", async () => {
    const runtime = new InMemoryRuntime();
    await expect(runtime.deleteNamespace("never-existed")).resolves.toBeUndefined();
  });

  it("clears the namespace's labels, policy and quota", async () => {
    const runtime = new InMemoryRuntime();
    await runtime.ensureNamespace("env-ns", { "platform/env": "env-1" });
    await runtime.applyDefaultDenyPolicy("env-ns");
    await runtime.applyQuota("env-ns", { requests: { cpu: "1", memory: "1Gi" }, limits: { cpu: "1", memory: "1Gi" }, pods: 5 });

    await runtime.deleteNamespace("env-ns");

    expect(runtime.environmentState("env-ns")).toEqual({ labels: null, defaultDeny: false, quota: null });
  });
});

describe("tailLogs", () => {
  async function collect(iter: AsyncIterable<string>): Promise<string[]> {
    const lines: string[] = [];
    for await (const line of iter) lines.push(line);
    return lines;
  }

  it("returns the lines populated by seedLogs, in order", async () => {
    const runtime = new InMemoryRuntime();
    await runtime.applyWorkload(spec);
    runtime.seedLogs("wl-1", ["line 1", "line 2"]);

    expect(await collect(runtime.tailLogs(REF))).toEqual(["line 1", "line 2"]);
  });

  it("with no buffer populated, yields a deterministic line if the workload exists", async () => {
    const runtime = new InMemoryRuntime();
    await runtime.applyWorkload(spec);

    expect(await collect(runtime.tailLogs(REF))).toEqual(["[sim] wl-1: workload running"]);
  });

  it("a nonexistent workload yields no lines", async () => {
    const runtime = new InMemoryRuntime();

    expect(await collect(runtime.tailLogs({ name: "nope", namespace: "env-ns" }))).toEqual([]);
  });
});
