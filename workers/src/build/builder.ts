// Build port (architecture.md §3). Only the reconciler calls this interface.
// Implementations: InMemoryBuilder (tests) and K8sBuilder (BuildKit Job on the cluster).

export interface BuildRequest {
  deploymentId: string;
  serviceInstanceId: string;
  repoUrl: string;
  commitSha: string;
  // Dockerfile directory inside the repo ("/" = root).
  rootDir: string;
}

export type BuildStatus =
  | { kind: "running" }
  // Full reference by digest: `registry/repo@sha256:...`.
  | { kind: "succeeded"; imageDigest: string }
  | { kind: "failed"; reason: string };

export interface Builder {
  // Idempotent: starting a build that already exists does nothing.
  start(req: BuildRequest): Promise<void>;
  status(req: Pick<BuildRequest, "deploymentId" | "serviceInstanceId">): Promise<BuildStatus>;
  // Latest snapshot of the build containers' logs (gate, clone, build). Empty if the build hasn't started yet.
  logs(req: Pick<BuildRequest, "deploymentId" | "serviceInstanceId">): Promise<string>;
  // Deletes the build of a cancelled deployment. Idempotent: not an error if the build doesn't exist.
  cancel(req: Pick<BuildRequest, "deploymentId" | "serviceInstanceId">): Promise<void>;
}
