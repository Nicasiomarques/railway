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

// Registra as chamadas ao runtime, para verificar quais passos rodaram.
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

// Falha na primeira chamada de cada passo listado.
class FlakyRuntime extends SpyRuntime {
  constructor(private readonly failOn: string) {
    super();
  }
  async applyDefaultDenyPolicy(ns: string) {
    if (this.failOn === "default-deny-policy") throw new Error("API do cluster indisponível");
    return super.applyDefaultDenyPolicy(ns);
  }
}

function setup(overrides: { status?: "pending" | "provisioning" | "ready" | "failed"; completedSteps?: string[] } = {}) {
  const store = new InMemoryEnvironmentStore();
  store.add({ id: ENV, projectId: "proj-1", ...overrides });
  return store;
}

describe("provisionEnvironment", () => {
  it("aplica namespace, default-deny e quota nessa ordem e marca o ambiente como ready", async () => {
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

  it("retoma do ponto de falha: passos já concluídos não rodam de novo", async () => {
    const store = setup({ status: "provisioning", completedSteps: ["namespace"] });
    const spy = new SpyRuntime();

    await provisionEnvironment({ store, runtime: spy }, { environmentId: ENV });

    expect(spy.calls).toEqual(["default-deny-policy", "quota"]);
    expect(store.snapshot(ENV)?.status).toBe("ready");
  });

  it("ambiente já pronto não toca o runtime", async () => {
    const store = setup({ status: "ready", completedSteps: ["namespace", "default-deny-policy", "quota"] });
    const spy = new SpyRuntime();

    const result = await provisionEnvironment({ store, runtime: spy }, { environmentId: ENV });

    expect(result).toEqual({ kind: "ready", environmentId: ENV });
    expect(spy.calls).toEqual([]);
  });

  it("ambiente inexistente devolve missing sem tocar o runtime", async () => {
    const spy = new SpyRuntime();

    const result = await provisionEnvironment({ store: setup(), runtime: spy }, { environmentId: "nope" });

    expect(result).toEqual({ kind: "missing", environmentId: "nope" });
    expect(spy.calls).toEqual([]);
  });
});

describe("handleProvisionEnvironmentJob", () => {
  it("erro transitório: registra o erro, mantém o status e relança para retry", async () => {
    const store = setup();
    const runtime = new FlakyRuntime("default-deny-policy");

    await expect(
      handleProvisionEnvironmentJob({ store, runtime }, { environmentId: ENV }, BUDGET),
    ).rejects.toThrow("API do cluster indisponível");

    expect(store.snapshot(ENV)).toMatchObject({
      status: "provisioning",
      completedSteps: ["namespace"],
      error: "API do cluster indisponível",
    });
  });

  it("nova tentativa após falha transitória conclui a saga sem repetir o namespace", async () => {
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

  it("na última tentativa, a falha marca o ambiente como failed com o motivo", async () => {
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
      error: "erro após 3 tentativas: API do cluster indisponível",
    });
  });
});
