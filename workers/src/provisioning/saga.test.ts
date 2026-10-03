import { describe, expect, it } from "vitest";
import { InMemoryRuntime } from "../runtime/in-memory.js";
import type { EnvironmentQuota, EnvironmentRuntime } from "../runtime/environment.js";
import { DEFAULT_ENV_QUOTA } from "../runtime/environment.js";
import { namespaceFor } from "../runtime/adapter.js";
import { InMemoryEnvironmentStore } from "./in-memory-store.js";
import { handleProvisionEnvironmentJob, provisionEnvironment } from "./saga.js";

const ENV = "env-1";
const NS = namespaceFor(ENV);
const BUDGET = { attemptsMade: 0, maxAttempts: 3 };

// Records the calls to the runtime, to verify which steps ran.
class SpyRuntime implements EnvironmentRuntime {
  readonly calls: string[] = [];
  constructor(private readonly inner: EnvironmentRuntime = new InMemoryRuntime()) {}
  async ensureNamespace(ns: string, labels: Record<string, string>) {
    this.calls.push("namespace");
    return this.inner.ensureNamespace(ns, labels);
  }
  async applyDefaultDenyPolicy(ns: string) {
    this.calls.push("default-deny-policy");
    return this.inner.applyDefaultDenyPolicy(ns);
  }
  async applyQuota(ns: string, quota: EnvironmentQuota) {
    this.calls.push("quota");
    return this.inner.applyQuota(ns, quota);
  }
}

// Fails on the first call of each listed step.
class FlakyRuntime extends SpyRuntime {
  constructor(private readonly failOn: string) {
    super();
  }
  async applyDefaultDenyPolicy(ns: string) {
    if (this.failOn === "default-deny-policy") throw new Error("cluster API unavailable");
    return super.applyDefaultDenyPolicy(ns);
  }
}

function setup(overrides: { status?: "pending" | "provisioning" | "ready" | "failed"; completedSteps?: string[] } = {}) {
  const store = new InMemoryEnvironmentStore();
  store.add({ id: ENV, projectId: "proj-1", ...overrides });
  return store;
}

describe("provisionEnvironment", () => {
  it("applies namespace, default-deny and quota in that order and marks the environment as ready", async () => {
    const store = setup();
    const runtime = new InMemoryRuntime();
    const spy = new SpyRuntime(runtime);

    const result = await provisionEnvironment({ store, runtime: spy }, { environmentId: ENV });

    expect(result).toEqual({ kind: "ready", environmentId: ENV });
    expect(spy.calls).toEqual(["namespace", "default-deny-policy", "quota"]);
    expect(runtime.environmentState(NS)).toEqual({
      labels: {
        "pod-security.kubernetes.io/enforce": "restricted",
        "platform/project": "proj-1",
        "platform/env": ENV,
      },
      defaultDeny: true,
      quota: DEFAULT_ENV_QUOTA,
    });
    expect(store.snapshot(ENV)).toMatchObject({
      status: "ready",
      completedSteps: ["namespace", "default-deny-policy", "quota"],
    });
  });

  it("resumes from the point of failure: already completed steps don't run again", async () => {
    const store = setup({ status: "provisioning", completedSteps: ["namespace"] });
    const spy = new SpyRuntime();

    await provisionEnvironment({ store, runtime: spy }, { environmentId: ENV });

    expect(spy.calls).toEqual(["default-deny-policy", "quota"]);
    expect(store.snapshot(ENV)?.status).toBe("ready");
  });

  it("an already ready environment doesn't touch the runtime", async () => {
    const store = setup({ status: "ready", completedSteps: ["namespace", "default-deny-policy", "quota"] });
    const spy = new SpyRuntime();

    const result = await provisionEnvironment({ store, runtime: spy }, { environmentId: ENV });

    expect(result).toEqual({ kind: "ready", environmentId: ENV });
    expect(spy.calls).toEqual([]);
  });

  it("a nonexistent environment returns missing without touching the runtime", async () => {
    const spy = new SpyRuntime();

    const result = await provisionEnvironment({ store: setup(), runtime: spy }, { environmentId: "nope" });

    expect(result).toEqual({ kind: "missing", environmentId: "nope" });
    expect(spy.calls).toEqual([]);
  });
});

describe("handleProvisionEnvironmentJob", () => {
  it("transient error: records the error, keeps the status and rethrows for retry", async () => {
    const store = setup();
    const runtime = new FlakyRuntime("default-deny-policy");

    await expect(
      handleProvisionEnvironmentJob({ store, runtime }, { environmentId: ENV }, BUDGET),
    ).rejects.toThrow("cluster API unavailable");

    expect(store.snapshot(ENV)).toMatchObject({
      status: "provisioning",
      completedSteps: ["namespace"],
      error: "cluster API unavailable",
    });
  });

  it("retrying after a transient failure finishes the saga without repeating the namespace", async () => {
    const store = setup();
    const runtime = new InMemoryRuntime();
    const flaky = new FlakyRuntime("default-deny-policy");
    await expect(handleProvisionEnvironmentJob({ store, runtime: flaky }, { environmentId: ENV }, BUDGET)).rejects.toThrow();

    const retry = new SpyRuntime(runtime);
    const result = await handleProvisionEnvironmentJob({ store, runtime: retry }, { environmentId: ENV }, { attemptsMade: 1, maxAttempts: 3 });

    expect(result).toEqual({ kind: "ready", environmentId: ENV });
    expect(retry.calls).toEqual(["default-deny-policy", "quota"]);
    expect(store.snapshot(ENV)?.status).toBe("ready");
  });

  it("on the last attempt, the failure marks the environment as failed with the reason", async () => {
    const store = setup();
    const runtime = new FlakyRuntime("default-deny-policy");

    const result = await handleProvisionEnvironmentJob(
      { store, runtime },
      { environmentId: ENV },
      { attemptsMade: 2, maxAttempts: 3 },
    );

    expect(result).toEqual({ kind: "failed", environmentId: ENV });
    expect(store.snapshot(ENV)).toMatchObject({
      status: "failed",
      error: "error after 3 attempts: cluster API unavailable",
    });
  });
});
