import { describe, expect, it } from "vitest";
import { workloadName } from "./adapter.js";
import { InMemoryRuntimeRegistry, SingleRegionRuntimeRegistry } from "./registry.js";
import { InMemoryRuntime } from "./in-memory.js";

describe("InMemoryRuntimeRegistry", () => {
  it("gives each region its own isolated runtime", async () => {
    const registry = new InMemoryRuntimeRegistry();
    const a = registry.forRegion("region-a");
    const b = registry.forRegion("region-b");

    await a.applyWorkload({ name: workloadName("inst-1"), namespace: "env-1", image: "img@sha256:a", env: {}, replicas: 1 });

    expect(await a.getStatus({ name: workloadName("inst-1"), namespace: "env-1" })).not.toBeNull();
    expect(await b.getStatus({ name: workloadName("inst-1"), namespace: "env-1" })).toBeNull();
  });

  it("returns the same runtime instance for the same region on repeated calls", () => {
    const registry = new InMemoryRuntimeRegistry();
    expect(registry.forRegion("region-a")).toBe(registry.forRegion("region-a"));
  });
});

describe("SingleRegionRuntimeRegistry", () => {
  it("resolves every regionId to the same wrapped adapter", () => {
    const adapter = new InMemoryRuntime();
    const registry = new SingleRegionRuntimeRegistry(adapter);

    expect(registry.forRegion("region-a")).toBe(adapter);
    expect(registry.forRegion("region-b")).toBe(adapter);
  });
});
