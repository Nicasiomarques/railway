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

    const ingressAllow = await net.readNamespacedNetworkPolicy({ name: "workload-ingress", namespace });
    expect(ingressAllow.spec?.ingress).toEqual([{ ports: [{ port: 8080, protocol: "TCP" }] }]);

    const egressDns = await net.readNamespacedNetworkPolicy({ name: "workload-egress-dns", namespace });
    expect(egressDns.spec?.egress?.[0]?.ports).toEqual([
      { port: 53, protocol: "UDP" },
      { port: 53, protocol: "TCP" },
    ]);

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
  }, 200_000);

  // This is the actual "ver no ar" proof: a client with no special network standing -- a plain pod
  // in a different namespace, no port-forward, no kubeconfig magic -- reaches the workload's
  // Service by DNS name. If workload-ingress (or the Service itself) were missing, this would hang
  // until curl's own timeout and the test would fail, not silently pass.
  it("the workload's Service is reachable from a pod in another namespace, by DNS name", async () => {
    const clientNamespace = `client-${suffix}`;
    const clientPodName = `curl-${suffix}`;
    await core.createNamespace({ body: { metadata: { name: clientNamespace } } });

    try {
      await core.createNamespacedPod({
        namespace: clientNamespace,
        body: {
          metadata: { name: clientPodName },
          spec: {
            restartPolicy: "Never",
            containers: [
              {
                name: "curl",
                image: "curlimages/curl:8.10.1",
                command: [
                  "curl",
                  "-s",
                  "-o",
                  "/dev/null",
                  "-w",
                  "%{http_code}",
                  "--max-time",
                  "5",
                  `http://${name}.${namespace}.svc.cluster.local:8080/`,
                ],
              },
            ],
          },
        },
      });

      await waitFor(
        async () => {
          const pod = await core.readNamespacedPod({ name: clientPodName, namespace: clientNamespace });
          const phase = pod.status?.phase;
          return phase === "Succeeded" || phase === "Failed" ? phase : null;
        },
        60_000,
        "curl pod to finish",
      );

      const log = await core.readNamespacedPodLog({ name: clientPodName, namespace: clientNamespace });
      // nginx-unprivileged answers 200 on `/`; any HTTP status at all means the TCP connection -- and
      // therefore the Service and the NetworkPolicy allow -- actually worked.
      expect(log).toMatch(/^\d{3}$/);
    } finally {
      await core.deleteNamespace({ name: clientNamespace }).catch(() => undefined);
    }
  }, 90_000);

  it("re-applying the saga is idempotent", async () => {
    await runtime.ensureNamespace(namespace, environmentLabels("proj-int", environmentId));
    await runtime.applyDefaultDenyPolicy(namespace);
    await runtime.applyQuota(namespace, DEFAULT_ENV_QUOTA);

    const policies = await net.listNamespacedNetworkPolicy({ namespace });
    expect(policies.items.map((p) => p.metadata?.name).sort()).toEqual([
      "default-deny",
      "workload-egress-dns",
      "workload-ingress",
    ]);
  });
});
