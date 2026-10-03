import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { K8sBuilder } from "./k8s-builder.js";
import type { BuildStatus } from "./builder.js";

// Runs with the cluster and a test repo reachable by the cluster:
//   K8S_TEST_CONTEXT=k3d-railway-dev BUILD_TEST_REPO_URL=http://host.k3d.internal:8189/app.git BUILD_TEST_COMMIT=<sha>
const CONTEXT = process.env.K8S_TEST_CONTEXT;
const REPO = process.env.BUILD_TEST_REPO_URL;
const COMMIT = process.env.BUILD_TEST_COMMIT;
const REGISTRY = process.env.BUILD_REGISTRY ?? "k3d-railway-reg:5000";
// Same registry as seen from the host (the cluster's internal name doesn't resolve from here).
const REGISTRY_HTTP = process.env.BUILD_TEST_REGISTRY_HTTP ?? "http://localhost:5050";
const enabled = Boolean(CONTEXT && REPO && COMMIT);
// Outbound destinations allowed by the build namespace's egress policy (same format as BUILD_EGRESS_ALLOW).
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
  throw new Error("timeout waiting for the build");
}

describe.skipIf(!enabled)("K8sBuilder on the cluster", () => {
  const builder = K8sBuilder.fromContext(CONTEXT, { registry: REGISTRY, namespace: "builds", timeoutSeconds: 600, processSandbox: "none", egressAllow });
  const req = {
    deploymentId: randomUUID(),
    serviceInstanceId: randomUUID(),
    repoUrl: REPO!,
    commitSha: COMMIT!,
    rootDir: "/",
  };

  afterAll(async () => {
    // Test Jobs expire on their own (ttlSecondsAfterFinished); nothing to clean up here.
  });

  it("builds the repo, publishes by digest and reports the full reference", async () => {
    await builder.start(req);
    const outcome = await waitForOutcome(builder, req, 300_000);

    expect(outcome).toMatchObject({ kind: "succeeded" });
    const imageDigest = (outcome as { imageDigest: string }).imageDigest;
    expect(imageDigest).toMatch(new RegExp(`^${REGISTRY.replace(/[.:]/g, "\\$&")}/workloads/${req.serviceInstanceId}@sha256:[a-f0-9]{64}$`));

    // The reported digest actually exists in the registry: query it via the host, where it's exposed.
    const digest = imageDigest.split("@")[1];
    const repo = `workloads/${req.serviceInstanceId}`;
    const manifest = await fetch(`${REGISTRY_HTTP}/v2/${repo}/manifests/${digest}`, {
      method: "HEAD",
      headers: { accept: "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" },
    });
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("docker-content-digest")).toBe(digest);
  }, 320_000);

  it("a repeated start is idempotent and the status doesn't change", async () => {
    const before = await builder.status(req);
    await builder.start(req);
    expect(await builder.status(req)).toEqual(before);
  });

  it("a deployment with no Job returns an explicit failure", async () => {
    const outcome = await builder.status({ deploymentId: randomUUID(), serviceInstanceId: req.serviceInstanceId });
    expect(outcome).toEqual({ kind: "failed", reason: expect.stringContaining("not found") });
  });
});

describe.skipIf(!enabled)("cancellation on the cluster", () => {
  it("cancel deletes the Job: the status becomes 'not found'", async () => {
    const builder = K8sBuilder.fromContext(CONTEXT, { registry: REGISTRY, namespace: "builds", timeoutSeconds: 600, processSandbox: "none", egressAllow: [] });
    const req = { deploymentId: randomUUID(), serviceInstanceId: randomUUID(), repoUrl: REPO!, commitSha: COMMIT!, rootDir: "/" };
    await builder.start(req);
    expect(await builder.status(req)).toEqual({ kind: "running" });

    await builder.cancel(req);

    expect(await builder.status(req)).toEqual({ kind: "failed", reason: expect.stringContaining("not found") });
    await builder.cancel(req); // repeating is safe
  }, 60_000);
});

describe.skipIf(!enabled)("build logs on the cluster", () => {
  it("the snapshot carries the build phases, in gate → clone → build order", async () => {
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

// Repos with no Dockerfile: the detector picks the stack. Only run with the support repos configured:
//   BUILD_TEST_NODE_REPO_URL / BUILD_TEST_NODE_COMMIT (Node app) and BUILD_TEST_PLAIN_REPO_URL / BUILD_TEST_PLAIN_COMMIT (no stack)
const NODE_REPO = process.env.BUILD_TEST_NODE_REPO_URL;
const NODE_COMMIT = process.env.BUILD_TEST_NODE_COMMIT;
const PLAIN_REPO = process.env.BUILD_TEST_PLAIN_REPO_URL;
const PLAIN_COMMIT = process.env.BUILD_TEST_PLAIN_COMMIT;

describe.skipIf(!(enabled && NODE_REPO && NODE_COMMIT))("detection on the cluster: Node app with no Dockerfile", () => {
  it("detects Node, builds and publishes the image", async () => {
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

describe.skipIf(!(enabled && PLAIN_REPO && PLAIN_COMMIT))("detection on the cluster: repo with no recognized stack", () => {
  it("fails at the detect stage and the justification shows up in the logs", async () => {
    const builder = K8sBuilder.fromContext(CONTEXT, { registry: REGISTRY, namespace: "builds", timeoutSeconds: 600, processSandbox: "none", egressAllow });
    const req = { deploymentId: randomUUID(), serviceInstanceId: randomUUID(), repoUrl: PLAIN_REPO!, commitSha: PLAIN_COMMIT!, rootDir: "/" };
    await builder.start(req);

    const outcome = await waitForOutcome(builder, req, 300_000);
    const logs = await builder.logs(req);

    expect(outcome).toEqual({ kind: "failed", reason: "stage detect failed (code 2)" });
    expect(logs).toContain("no recognized stack file");
    await builder.cancel(req);
  }, 320_000);
});
