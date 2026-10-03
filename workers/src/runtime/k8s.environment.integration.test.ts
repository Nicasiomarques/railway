import * as k8s from "@kubernetes/client-node";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPodReady, K8sRuntime } from "./k8s.js";
import { DEFAULT_ENV_QUOTA, environmentLabels } from "./environment.js";
import type { WorkloadSpec } from "./adapter.js";

// Runs only with K8S_TEST_CONTEXT=k3d-railway-dev (or another kubeconfig context).
// Confirms on the real cluster what the unit tests only check as objects: the namespace accepts the manifests
// and a workload with no `resources` comes up with the LimitRange defaults, within the quota.
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

describe.skipIf(!CONTEXT)("environment provisioning on the cluster", () => {
  let kc: k8s.KubeConfig;
  let runtime: K8sRuntime;
  let net: k8s.NetworkingV1Api;
  let core: k8s.CoreV1Api;

  const suffix = randomUUID().slice(0, 8);
  const environmentId = `env-int-${suffix}`;
  const namespace = `env-${environmentId}`;
  const name = `wl-int-${suffix}`;

  beforeAll(async () => {
    kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    kc.setCurrentContext(CONTEXT!);
    core = kc.makeApiClient(k8s.CoreV1Api);
    net = kc.makeApiClient(k8s.NetworkingV1Api);
    runtime = new K8sRuntime(kc);
  });

  afterAll(async () => {
    await core.deleteNamespace({ name: namespace }).catch(() => undefined);
  });

  it("applies namespace, default-deny and quota, and a workload with no resources comes up within them", async () => {
    await runtime.ensureNamespace(namespace, environmentLabels("proj-int", environmentId));
    await runtime.applyDefaultDenyPolicy(namespace);
    await runtime.applyQuota(namespace, DEFAULT_ENV_QUOTA);

    const ns = await core.readNamespace({ name: namespace });
    expect(ns.metadata?.labels).toMatchObject({
      "pod-security.kubernetes.io/enforce": "restricted",
      "platform/project": "proj-int",
      "platform/env": environmentId,
    });

    const policy = await net.readNamespacedNetworkPolicy({ name: "default-deny", namespace });
    expect(policy.spec?.policyTypes).toEqual(["Ingress", "Egress"]);

    const quota = await core.readNamespacedResourceQuota({ name: "env-quota", namespace });
    expect(quota.spec?.hard).toMatchObject({ pods: "20", "limits.memory": "8Gi" });

    // Without the LimitRange, the CPU/memory quota would reject this pod for lacking requests/limits.
    const spec: WorkloadSpec = { name, namespace, image: APP_IMAGE, env: {}, replicas: 1 };
    await runtime.applyWorkload(spec);

    const pod = await waitFor(
      async () => {
        const pods = await core.listNamespacedPod({ namespace, labelSelector: `platform/workload=${name}` });
        return pods.items.find(isPodReady) ?? null;
      },
      120_000,
      "workload pod ready inside the provisioned environment",
    );
    expect(pod.spec?.containers[0]?.resources?.limits).toEqual({ cpu: "500m", memory: "512Mi" });
  });

  it("re-applying the saga is idempotent", async () => {
    await runtime.ensureNamespace(namespace, environmentLabels("proj-int", environmentId));
    await runtime.applyDefaultDenyPolicy(namespace);
    await runtime.applyQuota(namespace, DEFAULT_ENV_QUOTA);

    const policies = await net.listNamespacedNetworkPolicy({ namespace });
    expect(policies.items.map((p) => p.metadata?.name)).toEqual(["default-deny"]);
  });
});
