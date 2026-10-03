import { describe, expect, it } from "vitest";
import { InMemoryRuntime } from "./in-memory.js";

const REF = { name: "wl-1", namespace: "env-ns" };
const spec = { name: "wl-1", namespace: "env-ns", image: "app@sha256:aaa", env: { A: "1", B: "2" }, replicas: 1 };

describe("InMemoryRuntime", () => {
  it("aplicar o mesmo spec de novo mantém as réplicas prontas", async () => {
    const runtime = new InMemoryRuntime();
    await runtime.applyWorkload(spec);
    runtime.markReady("wl-1");

    await runtime.applyWorkload({ ...spec, env: { B: "2", A: "1" } });

    expect(await runtime.getStatus(REF)).toMatchObject({ readyReplicas: 1 });
  });

  it("mudar a imagem inicia um rollout sem réplicas prontas", async () => {
    const runtime = new InMemoryRuntime();
    await runtime.applyWorkload(spec);
    runtime.markReady("wl-1");

    await runtime.applyWorkload({ ...spec, image: "app@sha256:bbb" });

    expect(await runtime.getStatus(REF)).toEqual({ image: "app@sha256:bbb", replicas: 1, readyReplicas: 0 });
  });

  it("workload inexistente devolve null", async () => {
    expect(await new InMemoryRuntime().getStatus({ name: "nope", namespace: "env-ns" })).toBeNull();
  });
});
