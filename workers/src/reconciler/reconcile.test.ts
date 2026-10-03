import { describe, expect, it } from "vitest";
import { namespaceFor, workloadName } from "../runtime/adapter.js";
import { InMemoryRuntime } from "../runtime/in-memory.js";
import { InMemoryDeploymentStore } from "./in-memory-store.js";
import { handleReconcileJob, reconcileInstance } from "./reconcile.js";
import { PermanentError } from "./errors.js";
import { InMemoryBuilder } from "../build/in-memory-builder.js";
import type { DeploymentRecord } from "./store.js";

const INSTANCE = "inst-1";
const ENVIRONMENT = "env-1";
const REF = { name: workloadName(INSTANCE), namespace: namespaceFor(ENVIRONMENT) };
const IMAGE_V1 = "registry.local/app@sha256:aaa";
const IMAGE_V2 = "registry.local/app@sha256:bbb";

function deployment(overrides: Partial<DeploymentRecord> & Pick<DeploymentRecord, "id" | "status">): DeploymentRecord {
  return {
    serviceInstanceId: INSTANCE,
    environmentId: ENVIRONMENT,
    versionNo: 1,
    imageDigest: IMAGE_V1,
    commitSha: null,
    repoUrl: null,
    rootDir: "/",
    env: { PORT: "3000" },
    replicas: 1,
    ...overrides,
  };
}

function setup() {
  const store = new InMemoryDeploymentStore();
  const runtime = new InMemoryRuntime();
  const builder = new InMemoryBuilder();
  return { store, runtime, builder, deps: { store, runtime, builder } };
}

describe("reconcileInstance", () => {
  it("is idle when there's no active deployment", async () => {
    const { deps, store } = setup();
    store.add(deployment({ id: "d1", status: "Running" }));
    expect(await reconcileInstance(deps, INSTANCE)).toEqual({ kind: "idle" });
  });

  it("applies the workload, moves to HealthChecking and stays pending until the replicas become ready", async () => {
    const { deps, store, runtime } = setup();
    store.add(deployment({ id: "d1", status: "Deploying" }));

    const result = await reconcileInstance(deps, INSTANCE);

    expect(result).toEqual({ kind: "pending", deploymentId: "d1", reason: expect.any(String), phase: "HealthChecking" });
    expect(store.get("d1")!.status).toBe("HealthChecking");
    expect(await runtime.getStatus(REF)).toMatchObject({ image: IMAGE_V1, readyReplicas: 0 });
  });

  it("promotes to Running when the health check passes", async () => {
    const { deps, store, runtime } = setup();
    store.add(deployment({ id: "d1", status: "Deploying" }));
    await reconcileInstance(deps, INSTANCE);
    runtime.markReady(workloadName(INSTANCE));

    const result = await reconcileInstance(deps, INSTANCE);

    expect(result).toEqual({ kind: "converged", deploymentId: "d1" });
    expect(store.get("d1")!.status).toBe("Running");
  });

  it("rollout: the previous Running deployment only becomes Superseded once the new one is ready", async () => {
    const { deps, store, runtime } = setup();
    store.add(deployment({ id: "d1", status: "Running", versionNo: 1 }));
    store.add(deployment({ id: "d2", status: "Deploying", versionNo: 2, imageDigest: IMAGE_V2 }));

    await reconcileInstance(deps, INSTANCE);
    // While the new one isn't ready, the old one stays Running.
    expect(store.get("d1")!.status).toBe("Running");
    expect(store.get("d2")!.status).toBe("HealthChecking");

    runtime.markReady(workloadName(INSTANCE));
    await reconcileInstance(deps, INSTANCE);

    expect(store.get("d2")!.status).toBe("Running");
    expect(store.get("d1")!.status).toBe("Superseded");
  });

  it("a workload with the old image doesn't count as ready", async () => {
    const { deps, store, runtime } = setup();
    store.add(deployment({ id: "d1", status: "Running", versionNo: 1 }));
    store.add(deployment({ id: "d2", status: "Deploying", versionNo: 2, imageDigest: IMAGE_V2 }));
    // The runtime still runs v1, ready.
    await runtime.applyWorkload({ name: REF.name, namespace: REF.namespace, image: IMAGE_V1, env: { PORT: "3000" }, replicas: 1 });
    runtime.markReady(workloadName(INSTANCE));

    const result = await reconcileInstance(deps, INSTANCE);

    expect(result.kind).toBe("pending");
    expect(store.get("d1")!.status).toBe("Running");
  });

  it("is idempotent: running it again after converging changes nothing", async () => {
    const { deps, store, runtime } = setup();
    store.add(deployment({ id: "d1", status: "Deploying" }));
    await reconcileInstance(deps, INSTANCE);
    runtime.markReady(workloadName(INSTANCE));
    await reconcileInstance(deps, INSTANCE);
    const eventsAfterConverge = store.events.length;

    expect(await reconcileInstance(deps, INSTANCE)).toEqual({ kind: "idle" });
    expect(store.events.length).toBe(eventsAfterConverge);
  });

});

describe("handleReconcileJob (retries and final failure)", () => {
  it("a pending result with budget left throws an error for BullMQ to retry", async () => {
    const { deps, store } = setup();
    store.add(deployment({ id: "d1", status: "Deploying" }));

    await expect(
      handleReconcileJob(deps, { serviceInstanceId: INSTANCE }, { attemptsMade: 0, maxAttempts: 3 }),
    ).rejects.toThrow(/attempt 1 of 3/);
    expect(store.get("d1")!.status).toBe("HealthChecking");
  });

  it("on the last attempt, the deployment goes to Failed with the reason recorded", async () => {
    const { deps, store } = setup();
    store.add(deployment({ id: "d1", status: "Deploying" }));

    const result = await handleReconcileJob(deps, { serviceInstanceId: INSTANCE }, { attemptsMade: 2, maxAttempts: 3 });

    expect(result).toEqual({ kind: "failed", deploymentId: "d1" });
    expect(store.get("d1")!.status).toBe("Failed");
    const failure = store.events.at(-1)!;
    expect(failure.reason).toMatch(/health check did not pass after 3 attempts/);
  });

  it("after Running, reconciling is idle and doesn't downgrade the deployment", async () => {
    const { deps, store, runtime } = setup();
    store.add(deployment({ id: "d1", status: "Deploying" }));
    await reconcileInstance(deps, INSTANCE);
    runtime.markReady(workloadName(INSTANCE));
    await reconcileInstance(deps, INSTANCE);

    expect(await reconcileInstance(deps, INSTANCE)).toEqual({ kind: "idle" });
    expect(store.get("d1")!.status).toBe("Running");
  });
});

describe("handleReconcileJob: failure classification", () => {
  const budget = { attemptsMade: 0, maxAttempts: 3 };
  const lastAttempt = { attemptsMade: 2, maxAttempts: 3 };

  it("a deployment with no image_digest fails immediately, without spending retries", async () => {
    const { deps, store } = setup();
    store.add(deployment({ id: "d1", status: "Deploying", imageDigest: null }));

    const result = await handleReconcileJob(deps, { serviceInstanceId: INSTANCE }, budget);

    expect(result).toEqual({ kind: "failed", deploymentId: "d1" });
    expect(store.get("d1")!.status).toBe("Failed");
    expect(store.events.at(-1)!.reason).toMatch(/no image_digest/);
  });

  it("a PermanentError from the runtime fails the deployment even with retries left", async () => {
    const store = new InMemoryDeploymentStore();
    const runtime = {
      applyWorkload: async () => {
        throw new PermanentError("spec rejected by the cluster", "d1");
      },
      getStatus: async () => null,
      tailLogs: async function* () {},
    };
    store.add(deployment({ id: "d1", status: "Deploying" }));

    const result = await handleReconcileJob({ store, runtime }, { serviceInstanceId: INSTANCE }, budget);

    expect(result).toEqual({ kind: "failed", deploymentId: "d1" });
    expect(store.get("d1")!.status).toBe("Failed");
  });

  it("a transient error with retries left is rethrown and the deployment stays as it was", async () => {
    const store = new InMemoryDeploymentStore();
    const runtime = {
      applyWorkload: async () => {
        throw new Error("cluster api is down");
      },
      getStatus: async () => null,
      tailLogs: async function* () {},
    };
    store.add(deployment({ id: "d1", status: "Deploying" }));

    await expect(handleReconcileJob({ store, runtime }, { serviceInstanceId: INSTANCE }, budget)).rejects.toThrow(
      /cluster api is down/,
    );
    expect(store.get("d1")!.status).toBe("Deploying");
  });

  it("a transient error on the last attempt fails the deployment with the reason", async () => {
    const store = new InMemoryDeploymentStore();
    const runtime = {
      applyWorkload: async () => {
        throw new Error("cluster api is down");
      },
      getStatus: async () => null,
      tailLogs: async function* () {},
    };
    store.add(deployment({ id: "d1", status: "Deploying" }));

    const result = await handleReconcileJob({ store, runtime }, { serviceInstanceId: INSTANCE }, lastAttempt);

    expect(result).toEqual({ kind: "failed", deploymentId: "d1" });
    expect(store.get("d1")!.status).toBe("Failed");
    expect(store.events.at(-1)!.reason).toMatch(/error after 3 attempts: cluster api is down/);
  });
});

describe("newly created (Queued) deployment with an image by digest", () => {
  it("goes through Building and Deploying, without a build, and follows the normal path", async () => {
    const { deps, store, runtime } = setup();
    store.add(deployment({ id: "d1", status: "Queued" }));

    const first = await reconcileInstance(deps, INSTANCE);
    expect(first).toEqual({ kind: "pending", deploymentId: "d1", reason: expect.any(String), phase: "HealthChecking" });
    expect(store.events.map((e) => [e.from, e.to])).toEqual([
      ["Queued", "Building"],
      ["Building", "Deploying"],
      ["Deploying", "HealthChecking"],
    ]);
    expect(store.events[0].reason).toMatch(/build skipped/);

    runtime.markReady(workloadName(INSTANCE));
    expect(await reconcileInstance(deps, INSTANCE)).toEqual({ kind: "converged", deploymentId: "d1" });
    expect(store.get("d1")!.status).toBe("Running");
  });
});

describe("repository deployment: build stage", () => {
  const SHA = "c6ba3ae5b6c700cc04950ff8389d8a37f31e5913";
  const REPO = { commitSha: SHA, repoUrl: "http://host.k3d.internal:8189/app.git", imageDigest: null };
  const BUILT = "k3d-railway-reg:5000/workloads/inst-1@sha256:" + "c".repeat(64);

  it("a build in progress keeps the deployment in Building and stays pending in the Building phase", async () => {
    const { deps, store, builder } = setup();
    store.add(deployment({ id: "d1", status: "Queued", ...REPO }));

    const result = await reconcileInstance(deps, INSTANCE);

    expect(result).toEqual({ kind: "pending", deploymentId: "d1", reason: "build in progress", phase: "Building" });
    expect(store.get("d1")!.status).toBe("Building");
    expect(store.get("d1")!.imageDigest).toBeNull();
    expect(await builder.status({ deploymentId: "d1", serviceInstanceId: INSTANCE })).toEqual({ kind: "running" });
  });

  it("a finished build records the digest, moves to Deploying and converges after the health check", async () => {
    const { deps, store, runtime, builder } = setup();
    store.add(deployment({ id: "d1", status: "Queued", ...REPO }));
    await reconcileInstance(deps, INSTANCE);
    builder.finish("d1", { kind: "succeeded", imageDigest: BUILT });

    const built = await reconcileInstance(deps, INSTANCE);
    expect(built).toEqual({ kind: "pending", deploymentId: "d1", reason: expect.any(String), phase: "HealthChecking" });
    expect(store.get("d1")!.imageDigest).toBe(BUILT);
    expect(store.events.map((e) => e.to)).toEqual(["Building", "Deploying", "HealthChecking"]);

    runtime.markReady(workloadName(INSTANCE));
    expect(await reconcileInstance(deps, INSTANCE)).toEqual({ kind: "converged", deploymentId: "d1" });
  });

  it("a failing build sends the deployment to Failed right away, with the reason", async () => {
    const { deps, store, builder } = setup();
    store.add(deployment({ id: "d1", status: "Queued", ...REPO }));
    await reconcileInstance(deps, INSTANCE);
    builder.finish("d1", { kind: "failed", reason: "build failed (code 1)" });

    const result = await handleReconcileJob(deps, { serviceInstanceId: INSTANCE }, { attemptsMade: 0, maxAttempts: 3 });

    expect(result).toEqual({ kind: "failed", deploymentId: "d1" });
    expect(store.get("d1")!.status).toBe("Failed");
    expect(store.events.at(-1)!.reason).toBe("build failed: build failed (code 1)");
  });

  it("with no builder configured, a repository deployment fails permanently", async () => {
    const store = new InMemoryDeploymentStore();
    const runtime = new InMemoryRuntime();
    store.add(deployment({ id: "d1", status: "Queued", ...REPO }));

    const result = await handleReconcileJob({ store, runtime }, { serviceInstanceId: INSTANCE }, { attemptsMade: 0, maxAttempts: 3 });

    expect(result).toEqual({ kind: "failed", deploymentId: "d1" });
    expect(store.events.at(-1)!.reason).toMatch(/builder not configured/);
  });

  it("running out of budget during the build says the build didn't finish", async () => {
    const { deps, store } = setup();
    store.add(deployment({ id: "d1", status: "Queued", ...REPO }));
    await reconcileInstance(deps, INSTANCE);

    const result = await handleReconcileJob(deps, { serviceInstanceId: INSTANCE }, { attemptsMade: 239, maxAttempts: 240 });

    expect(result).toEqual({ kind: "failed", deploymentId: "d1" });
    expect(store.events.at(-1)!.reason).toMatch(/build did not finish after 240 attempts/);
  });

  it("an already recorded digest is not overwritten", async () => {
    const store = new InMemoryDeploymentStore();
    store.add(deployment({ id: "d1", status: "Building", imageDigest: BUILT }));
    expect(await store.setImageDigest("d1", "other@sha256:" + "d".repeat(64))).toBe(false);
    expect(store.get("d1")!.imageDigest).toBe(BUILT);
  });
});

describe("build logs", () => {
  const SHA = "c6ba3ae5b6c700cc04950ff8389d8a37f31e5913";
  const REPO = { commitSha: SHA, repoUrl: "http://host.k3d.internal:8189/app.git", imageDigest: null };

  it("each build read saves the latest log snapshot", async () => {
    const { deps, store, builder } = setup();
    store.add(deployment({ id: "d1", status: "Queued", ...REPO }));
    builder.setLogs("d1", "=== build ===\nphase 1");

    await reconcileInstance(deps, INSTANCE);

    expect(store.buildLogs.get("d1")).toBe("=== build ===\nphase 1");
  });

  it("failing to read logs doesn't change the build's result", async () => {
    const { deps, store, builder } = setup();
    store.add(deployment({ id: "d1", status: "Queued", ...REPO }));
    builder.logs = async () => {
      throw new Error("logs API unavailable");
    };

    const result = await reconcileInstance(deps, INSTANCE);

    expect(result).toEqual({ kind: "pending", deploymentId: "d1", reason: "build in progress", phase: "Building" });
    expect(store.get("d1")!.status).toBe("Building");
  });
});
