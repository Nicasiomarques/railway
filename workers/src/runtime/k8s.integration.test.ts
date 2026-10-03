import * as k8s from "@kubernetes/client-node";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPodReady, K8sRuntime } from "./k8s.js";
import { specHash, type WorkloadSpec } from "./adapter.js";

// Roda só com K8S_TEST_CONTEXT=k3d-railway-dev (ou outro contexto do kubeconfig).
// A imagem é fixada por digest, como manda a arquitetura.
const CONTEXT = process.env.K8S_TEST_CONTEXT;
const APP_IMAGE = "nginxinc/nginx-unprivileged@sha256:65e3e85dbaed8ba248841d9d58a899b6197106c23cb0ff1a132b7bfe0547e4c0";

async function waitFor<T>(fn: () => Promise<T | null | false>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timeout esperando: ${what}`);
}

describe.skipIf(!CONTEXT)("K8sRuntime no cluster", () => {
  // Montado em beforeAll: o corpo do describe roda mesmo quando os testes são pulados.
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

  it("aplica o workload e fica pronto com a imagem pedida", async () => {
    const status = await waitFor(
      async () => {
        const s = await runtime.getStatus({ name, namespace });
        return s && s.readyReplicas >= 1 ? s : null;
      },
      180_000,
      "réplica pronta (v1)",
    );
    expect(status).toEqual({ image: APP_IMAGE, replicas: 1, readyReplicas: 1 });
  }, 200_000);

  it("aplicar a mesma spec de novo é idempotente: nenhum pod novo", async () => {
    const before = (await core.listNamespacedPod({ namespace, labelSelector: `platform/workload=${name}` })).items.map((p) => p.metadata?.name);
    await runtime.applyWorkload(spec({ GREETING: "v1" }));
    const after = (await core.listNamespacedPod({ namespace, labelSelector: `platform/workload=${name}` })).items.map((p) => p.metadata?.name);
    expect(after.sort()).toEqual(before.sort());
  });

  it("mudar o env faz rollout: só conta como pronto o pod da spec nova", async () => {
    await runtime.applyWorkload(spec({ GREETING: "v2" }));

    await waitFor(
      async () => {
        const s = await runtime.getStatus({ name, namespace });
        return s && s.readyReplicas >= 1 ? s : null;
      },
      180_000,
      "réplica pronta (v2)",
    );

    // Pode haver um pod da v1 ainda pronto durante o rollout. O status tem que contar só os da v2.
    const v2 = specHash({ image: APP_IMAGE, env: { GREETING: "v2" } });
    const readyV2 = (await readyPods()).filter((p) => p.metadata?.labels?.["platform/spec-hash"] === v2).length;
    const current = (await runtime.getStatus({ name, namespace }))!;
    expect(current.readyReplicas).toBe(readyV2);
    expect(readyV2).toBeGreaterThanOrEqual(1);
  }, 200_000);

  it("workload inexistente devolve null", async () => {
    expect(await runtime.getStatus({ name: "wl-nao-existe", namespace })).toBeNull();
  });
});
