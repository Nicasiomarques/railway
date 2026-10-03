import type { BuildRequest, BuildStatus, Builder } from "./builder.js";

// Simulated builder: the test decides when the build finishes.
export class InMemoryBuilder implements Builder {
  private readonly builds = new Map<string, BuildStatus>();
  private readonly logBook = new Map<string, string>();

  async start(req: BuildRequest): Promise<void> {
    if (!this.builds.has(req.deploymentId)) this.builds.set(req.deploymentId, { kind: "running" });
  }

  async status({ deploymentId }: Pick<BuildRequest, "deploymentId">): Promise<BuildStatus> {
    return this.builds.get(deploymentId) ?? { kind: "failed", reason: "build not found" };
  }

  async logs({ deploymentId }: Pick<BuildRequest, "deploymentId">): Promise<string> {
    return this.logBook.get(deploymentId) ?? "";
  }

  setLogs(deploymentId: string, content: string): void {
    this.logBook.set(deploymentId, content);
  }

  async cancel({ deploymentId }: Pick<BuildRequest, "deploymentId">): Promise<void> {
    this.builds.set(deploymentId, { kind: "failed", reason: "build cancelled" });
  }

  finish(deploymentId: string, outcome: BuildStatus): void {
    this.builds.set(deploymentId, outcome);
  }
}
