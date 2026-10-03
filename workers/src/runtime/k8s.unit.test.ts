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

// Mocks only what `tailLogs` touches: pod listing (CoreV1Api) and the SDK's log client.
// Sem rede real; o cluster fica fora do escopo deste teste (ver k8s.integration.test.ts).
function runtimeWithPods(items: k8s.V1Pod[]): { runtime: K8sRuntime; listNamespacedPod: ReturnType<typeof vi.fn> } {
  const listNamespacedPod = vi.fn().mockResolvedValue({ items });
  const kubeconfig = { makeApiClient: () => ({ listNamespacedPod }) } as unknown as k8s.KubeConfig;
  return { runtime: new K8sRuntime(kubeconfig), listNamespacedPod };
}

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of iter) lines.push(line);
  return lines;
}

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
