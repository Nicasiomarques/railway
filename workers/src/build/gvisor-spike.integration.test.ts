import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { K8sBuilder } from "./k8s-builder.js";
import type { BuildStatus } from "./builder.js";

// Sandbox spike (architecture.md §7.2): the build runs under gVisor, with BuildKit's process sandbox on.
// Only runs with GVISOR_SPIKE=1, the cluster configured with the `gvisor` RuntimeClass, and the support Node repo:
//   GVISOR_SPIKE=1 K8S_TEST_CONTEXT=k3d-railway-dev BUILD_TEST_NODE_REPO_URL=... BUILD_TEST_NODE_COMMIT=...
const enabled = process.env.GVISOR_SPIKE === "1" && Boolean(process.env.K8S_TEST_CONTEXT && process.env.BUILD_TEST_NODE_REPO_URL && process.env.BUILD_TEST_NODE_COMMIT);

async function waitForOutcome(builder: K8sBuilder, req: { deploymentId: string; serviceInstanceId: string }, timeoutMs: number): Promise<BuildStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await builder.status(req);
    if (status.kind !== "running") return status;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("timeout waiting for the build");
}

describe.skipIf(!enabled)("gVisor spike: build with RUN under sandbox", () => {
  it("a Node app with RUN npm install finishes under gVisor with the process sandbox", async () => {
    const builder = K8sBuilder.fromContext(process.env.K8S_TEST_CONTEXT, {
      registry: process.env.BUILD_REGISTRY ?? "k3d-railway-reg:5000",
      namespace: "builds",
      timeoutSeconds: 600,
      processSandbox: "process",
      runtimeClass: "gvisor",
      buildkitdFlags: "--oci-worker-snapshotter=native",
      egressAllow: (process.env.BUILD_EGRESS_ALLOW ?? "").split(",").filter(Boolean).map((e) => {
        const [cidr, port] = e.split(":");
        return { cidr, port: Number(port) };
      }),
    });
    const req = {
      deploymentId: randomUUID(),
      serviceInstanceId: randomUUID(),
      repoUrl: process.env.BUILD_TEST_NODE_REPO_URL!,
      commitSha: process.env.BUILD_TEST_NODE_COMMIT!,
      rootDir: "/",
    };
    await builder.start(req);
    const outcome = await waitForOutcome(builder, req, 400_000);
    const logs = await builder.logs(req);
    console.log("SPIKE_OUTCOME", JSON.stringify(outcome));
    console.log("SPIKE_LOG_TAIL", logs.slice(-1500));
    expect(outcome).toMatchObject({ kind: "succeeded" });
  }, 420_000);
});
