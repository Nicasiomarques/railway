import * as k8s from "@kubernetes/client-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isPodReady, K8sRuntime } from "./k8s.js";
import { specHash } from "./adapter.js";

const pod = (overrides: Partial<k8s.V1Pod> & { ready?: string }): k8s.V1Pod => ({
  metadata: overrides.metadata ?? {},
  status: { conditions: overrides.ready ? [{ type: "Ready", status: overrides.ready }] : [] },
});

describe("isPodReady", () => {
  it("pod with Ready=True is ready", () => {
    expect(isPodReady(pod({ ready: "True" }))).toBe(true);
  });

  it("pod with Ready=False is not ready", () => {
    expect(isPodReady(pod({ ready: "False" }))).toBe(false);
  });

  it("a terminating pod doesn't count, even if still Ready", () => {
    expect(isPodReady(pod({ ready: "True", metadata: { deletionTimestamp: new Date() } }))).toBe(false);
  });
});

describe("specHash", () => {
  it("is independent of variable order", () => {
    expect(specHash({ image: "a@sha256:1", env: { A: "1", B: "2" } })).toBe(
      specHash({ image: "a@sha256:1", env: { B: "2", A: "1" } }),
    );
  });

  it("changes when the env changes or the image changes", () => {
    const base = specHash({ image: "a@sha256:1", env: { A: "1" } });
    expect(specHash({ image: "a@sha256:1", env: { A: "2" } })).not.toBe(base);
    expect(specHash({ image: "a@sha256:2", env: { A: "1" } })).not.toBe(base);
  });
});

describe("K8sRuntime.deleteNamespace", () => {
  it("calls deleteNamespace on the core API", async () => {
    const deleteNamespace = vi.fn().mockResolvedValue(undefined);
    const kubeconfig = { makeApiClient: () => ({ deleteNamespace }) } as unknown as k8s.KubeConfig;
    const runtime = new K8sRuntime(kubeconfig);

    await runtime.deleteNamespace("env-ns");

    expect(deleteNamespace).toHaveBeenCalledWith({ name: "env-ns" });
  });

  it("a 404 (already gone) is not an error", async () => {
    const deleteNamespace = vi.fn().mockRejectedValue({ statusCode: 404 });
    const kubeconfig = { makeApiClient: () => ({ deleteNamespace }) } as unknown as k8s.KubeConfig;
    const runtime = new K8sRuntime(kubeconfig);

    await expect(runtime.deleteNamespace("env-ns")).resolves.toBeUndefined();
  });

  it("another error propagates", async () => {
    const deleteNamespace = vi.fn().mockRejectedValue({ statusCode: 500 });
    const kubeconfig = { makeApiClient: () => ({ deleteNamespace }) } as unknown as k8s.KubeConfig;
    const runtime = new K8sRuntime(kubeconfig);

    await expect(runtime.deleteNamespace("env-ns")).rejects.toMatchObject({ statusCode: 500 });
  });
});

// Mocks only what `tailLogs` touches: pod listing (CoreV1Api) and the SDK's log client.
// Sem rede real; o cluster fica fora do escopo deste teste (ver k8s.integration.test.ts).
function runtimeWithPods(items: k8s.V1Pod[]): { runtime: K8sRuntime; listNamespacedPod: ReturnType<typeof vi.fn> } {
  const listNamespacedPod = vi.fn().mockResolvedValue({ items });
  const kubeconfig = { makeApiClient: () => ({ listNamespacedPod }) } as unknown as k8s.KubeConfig;
  return { runtime: new K8sRuntime(kubeconfig), listNamespacedPod };
}

// Mocks only what `applyWorkload` touches, split by API class the way K8sRuntime's constructor
// resolves them -- so a call lands on the fake the real client would have routed it to.
// No real cluster; that's k8s.integration.test.ts's job.
function runtimeForApply() {
  const core = { patchNamespace: vi.fn().mockResolvedValue({}), patchNamespacedSecret: vi.fn().mockResolvedValue({}) };
  const apps = { patchNamespacedDeployment: vi.fn().mockResolvedValue({}) };
  const autoscalingApi = {
    patchNamespacedHorizontalPodAutoscaler: vi.fn().mockResolvedValue({}),
    deleteNamespacedHorizontalPodAutoscaler: vi.fn().mockResolvedValue({}),
  };
  const kubeconfig = {
    makeApiClient: (apiClass: unknown) => {
      if (apiClass === k8s.AppsV1Api) return apps;
      if (apiClass === k8s.AutoscalingV2Api) return autoscalingApi;
      return core;
    },
  } as unknown as k8s.KubeConfig;
  return { runtime: new K8sRuntime(kubeconfig), core, apps, autoscalingApi };
}

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of iter) lines.push(line);
  return lines;
}

describe("K8sRuntime.applyWorkload autoscaling", () => {
  afterEach(() => vi.restoreAllMocks());

  const BASE_SPEC = { name: "wl-1", namespace: "env-ns", image: "img@sha256:a", env: {}, replicas: 2 };

  it("with no autoscaling policy, sets Deployment replicas directly and deletes any existing HPA", async () => {
    const { runtime, apps, autoscalingApi } = runtimeForApply();

    await runtime.applyWorkload(BASE_SPEC);

    expect(apps.patchNamespacedDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ spec: expect.objectContaining({ replicas: 2 }) }) }),
      expect.anything(),
    );
    expect(autoscalingApi.deleteNamespacedHorizontalPodAutoscaler).toHaveBeenCalledWith({ name: "wl-1", namespace: "env-ns" });
    expect(autoscalingApi.patchNamespacedHorizontalPodAutoscaler).not.toHaveBeenCalled();
  });

  it("deleting a nonexistent HPA (404) is not an error", async () => {
    const { runtime, autoscalingApi } = runtimeForApply();
    autoscalingApi.deleteNamespacedHorizontalPodAutoscaler.mockRejectedValue({ statusCode: 404 });

    await expect(runtime.applyWorkload(BASE_SPEC)).resolves.toBeUndefined();
  });

  it("with a policy, omits Deployment replicas, sets a CPU request, and applies an HPA", async () => {
    const { runtime, apps, autoscalingApi } = runtimeForApply();
    const spec = { ...BASE_SPEC, autoscaling: { minReplicas: 2, maxReplicas: 10, targetCpuPercent: 70, cpuRequestMillicores: 250 } };

    await runtime.applyWorkload(spec);

    const deploymentBody = apps.patchNamespacedDeployment.mock.calls[0][0].body;
    expect(deploymentBody.spec.replicas).toBeUndefined();
    expect(deploymentBody.spec.template.spec.containers[0].resources).toEqual({ requests: { cpu: "250m" } });

    expect(autoscalingApi.deleteNamespacedHorizontalPodAutoscaler).not.toHaveBeenCalled();
    expect(autoscalingApi.patchNamespacedHorizontalPodAutoscaler).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "wl-1",
        namespace: "env-ns",
        body: expect.objectContaining({
          spec: expect.objectContaining({
            scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name: "wl-1" },
            minReplicas: 2,
            maxReplicas: 10,
            metrics: [{ type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 70 } } }],
          }),
        }),
      }),
      expect.anything(),
    );
  });
});

describe("K8sRuntime.tailLogs", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resolves the pod by the workload's label and returns the stream's lines, in order", async () => {
    const readyPod = pod({ ready: "True", metadata: { name: "wl-1-abc" } });
    readyPod.spec = { containers: [{ name: "app" }] } as k8s.V1PodSpec;
    const { runtime, listNamespacedPod } = runtimeWithPods([readyPod]);

    vi.spyOn(k8s.Log.prototype, "log").mockImplementation(async (_ns, _podName, _container, stream) => {
      (stream as NodeJS.WritableStream).end("linha 1\nlinha 2\n");
      return new AbortController();
    });

    const lines = await collect(runtime.tailLogs({ name: "wl-1", namespace: "env-ns" }));

    expect(listNamespacedPod).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "env-ns", labelSelector: expect.stringContaining("wl-1") }),
    );
    expect(lines).toEqual(["linha 1", "linha 2"]);
  });

  it("with no pods for the workload, yields no lines", async () => {
    const { runtime } = runtimeWithPods([]);

    expect(await collect(runtime.tailLogs({ name: "wl-1", namespace: "env-ns" }))).toEqual([]);
  });
});
