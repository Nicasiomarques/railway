import { describe, expect, it } from "vitest";
import { namespaceFor } from "../runtime/adapter.js";
import { InMemoryRuntime } from "../runtime/in-memory.js";
import { InMemoryDecommissionStore } from "./in-memory-store.js";
import { decommissionEnvironment } from "./saga.js";

const ENV = "env-1";
const NS = namespaceFor(ENV);

function setup() {
  const store = new InMemoryDecommissionStore();
  const runtime = new InMemoryRuntime();
  return { store, runtime };
}

describe("decommissionEnvironment", () => {
  it("a nonexistent environment returns missing without touching the runtime", async () => {
    const { store, runtime } = setup();

    const result = await decommissionEnvironment({ store, runtime }, { environmentId: "nope" });

    expect(result).toEqual({ kind: "missing", environmentId: "nope" });
  });

  it("an environment with no ttl_at is not due", async () => {
    const { store, runtime } = setup();
    store.addEnvironment({ id: ENV, projectId: "proj-1", ttlAt: null });

    const result = await decommissionEnvironment({ store, runtime }, { environmentId: ENV });

    expect(result).toEqual({ kind: "not_due", environmentId: ENV });
    expect(store.isEnvironmentDeleted(ENV)).toBe(false);
  });

  it("an environment whose ttl_at is still in the future is not due", async () => {
    const { store, runtime } = setup();
    store.addEnvironment({ id: ENV, projectId: "proj-1", ttlAt: new Date(Date.now() + 60_000) });

    const result = await decommissionEnvironment({ store, runtime }, { environmentId: ENV });

    expect(result).toEqual({ kind: "not_due", environmentId: ENV });
  });

  it("deletes the namespace, the instance's domains, and soft-deletes the instance and the environment", async () => {
    const { store, runtime } = setup();
    store.addEnvironment({ id: ENV, projectId: "proj-1", ttlAt: new Date(Date.now() - 1000) });
    store.addServiceInstance({ id: "inst-1", environmentId: ENV });
    await runtime.applyWorkload({ name: "wl-inst-1", namespace: NS, image: "app@sha256:aaa", env: {}, replicas: 1 });

    const result = await decommissionEnvironment({ store, runtime }, { environmentId: ENV });

    expect(result).toEqual({ kind: "decommissioned", environmentId: ENV });
    expect(await runtime.getStatus({ name: "wl-inst-1", namespace: NS })).toBeNull();
    expect(store.domainsDeleted).toEqual(["inst-1"]);
    expect(await store.listServiceInstanceIds(ENV)).toEqual([]);
    expect(store.isEnvironmentDeleted(ENV)).toBe(true);
  });

  it("an environment with no live service instances still gets decommissioned", async () => {
    const { store, runtime } = setup();
    store.addEnvironment({ id: ENV, projectId: "proj-1", ttlAt: new Date(Date.now() - 1000) });

    const result = await decommissionEnvironment({ store, runtime }, { environmentId: ENV });

    expect(result).toEqual({ kind: "decommissioned", environmentId: ENV });
    expect(store.domainsDeleted).toEqual([]);
  });
});
