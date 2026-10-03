import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { K8sBuilder } from "./k8s-builder.js";
import type { BuildStatus } from "./builder.js";

// Roda com o cluster e um repo de teste acessível pelo cluster:
//   K8S_TEST_CONTEXT=k3d-railway-dev BUILD_TEST_REPO_URL=http://host.k3d.internal:8189/app.git BUILD_TEST_COMMIT=<sha>
const CONTEXT = process.env.K8S_TEST_CONTEXT;
const REPO = process.env.BUILD_TEST_REPO_URL;
const COMMIT = process.env.BUILD_TEST_COMMIT;
const REGISTRY = process.env.BUILD_REGISTRY ?? "k3d-railway-reg:5000";
// Mesmo registry visto do host (o nome interno do cluster não resolve daqui).
const REGISTRY_HTTP = process.env.BUILD_TEST_REGISTRY_HTTP ?? "http://localhost:5050";
const enabled = Boolean(CONTEXT && REPO && COMMIT);
// Saídas liberadas pela política de egress do namespace de build (mesmo formato de BUILD_EGRESS_ALLOW).
const egressAllow = (process.env.BUILD_EGRESS_ALLOW ?? "")
  .split(",")
  .filter(Boolean)
  .map((e) => {
    const [cidr, port] = e.split(":");
    return { cidr, port: Number(port) };
  });


async function waitForOutcome(builder: K8sBuilder, req: { deploymentId: string; serviceInstanceId: string }, timeoutMs: number): Promise<BuildStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await builder.status(req);
    if (status.kind !== "running") return status;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("timeout esperando o build");
}

describe.skipIf(!enabled)("K8sBuilder no cluster", () => {
  const builder = K8sBuilder.fromContext(CONTEXT, { registry: REGISTRY, namespace: "builds", timeoutSeconds: 600, processSandbox: "none", egressAllow });
  const req = {
    deploymentId: randomUUID(),
    serviceInstanceId: randomUUID(),
    repoUrl: REPO!,
    commitSha: COMMIT!,
    rootDir: "/",
  };

  afterAll(async () => {
    // Jobs de teste expiram sozinhos (ttlSecondsAfterFinished); nada a limpar aqui.
  });

  it("constrói o repo, publica por digest e reporta a referência completa", async () => {
    await builder.start(req);
    const outcome = await waitForOutcome(builder, req, 300_000);

    expect(outcome).toMatchObject({ kind: "succeeded" });
    const imageDigest = (outcome as { imageDigest: string }).imageDigest;
    expect(imageDigest).toMatch(new RegExp(`^${REGISTRY.replace(/[.:]/g, "\\$&")}/workloads/${req.serviceInstanceId}@sha256:[a-f0-9]{64}$`));

    // O digest reportado existe de fato no registry: consulta pelo host, onde ele é exposto.
    const digest = imageDigest.split("@")[1];
    const repo = `workloads/${req.serviceInstanceId}`;
    const manifest = await fetch(`${REGISTRY_HTTP}/v2/${repo}/manifests/${digest}`, {
      method: "HEAD",
      headers: { accept: "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" },
    });
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("docker-content-digest")).toBe(digest);
  }, 320_000);

  it("start repetido é idempotente e o status não muda", async () => {
    const before = await builder.status(req);
    await builder.start(req);
    expect(await builder.status(req)).toEqual(before);
  });

  it("deployment sem Job devolve falha explícita", async () => {
    const outcome = await builder.status({ deploymentId: randomUUID(), serviceInstanceId: req.serviceInstanceId });
    expect(outcome).toEqual({ kind: "failed", reason: expect.stringContaining("não encontrado") });
  });
});

describe.skipIf(!enabled)("cancelamento no cluster", () => {
  it("cancel apaga o Job: o status passa a ser 'não encontrado'", async () => {
    const builder = K8sBuilder.fromContext(CONTEXT, { registry: REGISTRY, namespace: "builds", timeoutSeconds: 600, processSandbox: "none", egressAllow: [] });
    const req = { deploymentId: randomUUID(), serviceInstanceId: randomUUID(), repoUrl: REPO!, commitSha: COMMIT!, rootDir: "/" };
    await builder.start(req);
    expect(await builder.status(req)).toEqual({ kind: "running" });

    await builder.cancel(req);

    expect(await builder.status(req)).toEqual({ kind: "failed", reason: expect.stringContaining("não encontrado") });
    await builder.cancel(req); // repetir é seguro
  }, 60_000);
});

describe.skipIf(!enabled)("logs do build no cluster", () => {
  it("o retrato traz as fases do build, na ordem gate → clone → build", async () => {
    const builder = K8sBuilder.fromContext(CONTEXT, { registry: REGISTRY, namespace: "builds", timeoutSeconds: 600, processSandbox: "none", egressAllow });
    const req = { deploymentId: randomUUID(), serviceInstanceId: randomUUID(), repoUrl: REPO!, commitSha: COMMIT!, rootDir: "/" };
    await builder.start(req);
    await waitForOutcome(builder, req, 300_000);

    const logs = await builder.logs(req);

    const gate = logs.indexOf("=== egress-gate ===");
    const clone = logs.indexOf("=== clone ===");
    const build = logs.indexOf("=== build ===");
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(clone).toBeGreaterThan(gate);
    expect(build).toBeGreaterThan(clone);
    expect(logs).toMatch(/pushing manifest/);
    await builder.cancel(req);
  }, 320_000);
});

// Repos sem Dockerfile: o detector escolhe a stack. Só rodam com os repos de apoio configurados:
//   BUILD_TEST_NODE_REPO_URL / BUILD_TEST_NODE_COMMIT (app Node) e BUILD_TEST_PLAIN_REPO_URL / BUILD_TEST_PLAIN_COMMIT (sem stack)
const NODE_REPO = process.env.BUILD_TEST_NODE_REPO_URL;
const NODE_COMMIT = process.env.BUILD_TEST_NODE_COMMIT;
const PLAIN_REPO = process.env.BUILD_TEST_PLAIN_REPO_URL;
const PLAIN_COMMIT = process.env.BUILD_TEST_PLAIN_COMMIT;

describe.skipIf(!(enabled && NODE_REPO && NODE_COMMIT))("detecção no cluster: app Node sem Dockerfile", () => {
  it("detecta Node, constrói e publica a imagem", async () => {
    const builder = K8sBuilder.fromContext(CONTEXT, { registry: REGISTRY, namespace: "builds", timeoutSeconds: 600, processSandbox: "none", egressAllow });
    const req = { deploymentId: randomUUID(), serviceInstanceId: randomUUID(), repoUrl: NODE_REPO!, commitSha: NODE_COMMIT!, rootDir: "/" };
    await builder.start(req);

    const outcome = await waitForOutcome(builder, req, 300_000);
    const logs = await builder.logs(req);

    expect(outcome).toMatchObject({ kind: "succeeded" });
    expect(logs).toContain("stack: node");
    expect(logs).toContain("scripts.start → npm start");
    await builder.cancel(req);
  }, 320_000);
});

describe.skipIf(!(enabled && PLAIN_REPO && PLAIN_COMMIT))("detecção no cluster: repo sem stack reconhecida", () => {
  it("falha na etapa detect e a justificativa aparece nos logs", async () => {
    const builder = K8sBuilder.fromContext(CONTEXT, { registry: REGISTRY, namespace: "builds", timeoutSeconds: 600, processSandbox: "none", egressAllow });
    const req = { deploymentId: randomUUID(), serviceInstanceId: randomUUID(), repoUrl: PLAIN_REPO!, commitSha: PLAIN_COMMIT!, rootDir: "/" };
    await builder.start(req);

    const outcome = await waitForOutcome(builder, req, 300_000);
    const logs = await builder.logs(req);

    expect(outcome).toEqual({ kind: "failed", reason: "etapa detect falhou (código 2)" });
    expect(logs).toContain("nenhum arquivo de stack reconhecido");
    await builder.cancel(req);
  }, 320_000);
});
