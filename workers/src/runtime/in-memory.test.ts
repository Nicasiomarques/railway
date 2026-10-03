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
