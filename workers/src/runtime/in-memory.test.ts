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

describe("tailLogs", () => {
  async function collect(iter: AsyncIterable<string>): Promise<string[]> {
    const lines: string[] = [];
    for await (const line of iter) lines.push(line);
    return lines;
  }

  it("devolve as linhas populadas por seedLogs, na ordem", async () => {
    const runtime = new InMemoryRuntime();
    await runtime.applyWorkload(spec);
    runtime.seedLogs("wl-1", ["linha 1", "linha 2"]);

    expect(await collect(runtime.tailLogs(REF))).toEqual(["linha 1", "linha 2"]);
  });

  it("sem buffer populado, gera uma linha determinística se o workload existir", async () => {
    const runtime = new InMemoryRuntime();
    await runtime.applyWorkload(spec);

    expect(await collect(runtime.tailLogs(REF))).toEqual(["[sim] wl-1: workload em execução"]);
  });

  it("workload inexistente não gera nenhuma linha", async () => {
    const runtime = new InMemoryRuntime();

    expect(await collect(runtime.tailLogs({ name: "nope", namespace: "env-ns" }))).toEqual([]);
  });
});
