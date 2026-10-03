import * as k8s from "@kubernetes/client-node";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPodReady, K8sRuntime } from "./k8s.js";
import { specHash, type WorkloadSpec } from "./adapter.js";

// Runs only with K8S_TEST_CONTEXT=k3d-railway-dev (or another kubeconfig context).
// The image is pinned by digest, as the architecture requires.
const CONTEXT = process.env.K8S_TEST_CONTEXT;
const APP_IMAGE = "nginxinc/nginx-unprivileged@sha256:65e3e85dbaed8ba248841d9d58a899b6197106c23cb0ff1a132b7bfe0547e4c0";

async function waitFor<T>(fn: () => Promise<T | null | false>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timeout waiting for: ${what}`);
}

describe.skipIf(!CONTEXT)("K8sRuntime no cluster", () => {
  // Set up in beforeAll: the describe body runs even when the tests are skipped.
  let core: k8s.CoreV1Api;
  let runtime: K8sRuntime;

  const suffix = randomUUID().slice(0, 8);
  const namespace = `env-test-${suffix}`;
  const name = `wl-test-${suffix}`;
  const spec = (env: Record<string, string>): WorkloadSpec => ({ name, namespace, image: APP_IMAGE, env, replicas: 1 });

  const readyPods = async () =>
    (await core.listNamespacedPod({ namespace, labelSelector: `platform/workload=${name}` })).items.filter(isPodReady);

  beforeAll(async () => {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    kc.setCurrentContext(CONTEXT!);
    core = kc.makeApiClient(k8s.CoreV1Api);
    runtime = new K8sRuntime(kc);
    await runtime.applyWorkload(spec({ GREETING: "v1" }));
  });

  afterAll(async () => {
    await core.deleteNamespace({ name: namespace }).catch(() => undefined);
  });

  it("applies the workload and becomes ready with the requested image", async () => {
    const status = await waitFor(
      async () => {
        const s = await runtime.getStatus({ name, namespace });
        return s && s.readyReplicas >= 1 ? s : null;
      },
      180_000,
      "replica ready (v1)",
    );
    expect(status).toEqual({ image: APP_IMAGE, replicas: 1, readyReplicas: 1 });
  }, 200_000);

  it("applying the same spec again is idempotent: no new pod", async () => {
    const before = (await core.listNamespacedPod({ namespace, labelSelector: `platform/workload=${name}` })).items.map((p) => p.metadata?.name);
    await runtime.applyWorkload(spec({ GREETING: "v1" }));
    const after = (await core.listNamespacedPod({ namespace, labelSelector: `platform/workload=${name}` })).items.map((p) => p.metadata?.name);
    expect(after.sort()).toEqual(before.sort());
  });

  it("changing the env triggers a rollout: only the pod of the new spec counts as ready", async () => {
    await runtime.applyWorkload(spec({ GREETING: "v2" }));

    await waitFor(
      async () => {
        const s = await runtime.getStatus({ name, namespace });
        return s && s.readyReplicas >= 1 ? s : null;
      },
      180_000,
      "replica ready (v2)",
    );

    // There may still be a ready v1 pod during the rollout. The status must only count the v2 ones.
    const v2 = specHash({ image: APP_IMAGE, env: { GREETING: "v2" } });
    const readyV2 = (await readyPods()).filter((p) => p.metadata?.labels?.["platform/spec-hash"] === v2).length;
    const current = (await runtime.getStatus({ name, namespace }))!;
    expect(current.readyReplicas).toBe(readyV2);
    expect(readyV2).toBeGreaterThanOrEqual(1);
  }, 200_000);

  it("nonexistent workload returns null", async () => {
    expect(await runtime.getStatus({ name: "wl-does-not-exist", namespace })).toBeNull();
  });
});
