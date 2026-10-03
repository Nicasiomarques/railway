import type { DeploymentStatus } from "@railway-like/shared";
import type { DeploymentRecord, DeploymentStore } from "./store.js";

export interface DeploymentEvent {
  deploymentId: string;
  from: DeploymentStatus;
  to: DeploymentStatus;
  reason?: string;
}

// In-memory store for tests. Mirrors the Postgres contract, including `promote`'s atomic write.
export class InMemoryDeploymentStore implements DeploymentStore {
  readonly events: DeploymentEvent[] = [];
  private readonly deployments = new Map<string, DeploymentRecord>();

  add(record: DeploymentRecord): void {
    this.deployments.set(record.id, { ...record, env: { ...record.env } });
  }

  get(id: string): DeploymentRecord | undefined {
    const d = this.deployments.get(id);
    return d && { ...d, env: { ...d.env } };
  }

  async findActive(serviceInstanceId: string): Promise<DeploymentRecord | null> {
    const candidates = [...this.deployments.values()].filter(
      (d) => d.serviceInstanceId === serviceInstanceId && ["Queued", "Building", "Deploying", "HealthChecking"].includes(d.status),
    );
    const latest = candidates.sort((a, b) => b.versionNo - a.versionNo)[0];
    return latest ? this.get(latest.id)! : null;
  }

  readonly buildLogs = new Map<string, string>();

  async saveBuildLog(id: string, content: string): Promise<void> {
    this.buildLogs.set(id, content);
  }

  async setImageDigest(id: string, imageDigest: string): Promise<boolean> {
    const d = this.deployments.get(id);
    if (!d || d.imageDigest !== null) return false;
    d.imageDigest = imageDigest;
    return true;
  }

  async setStatus(id: string, from: DeploymentStatus, to: DeploymentStatus, reason?: string): Promise<boolean> {
    const d = this.deployments.get(id);
    if (!d || d.status !== from) return false;
    d.status = to;
    this.events.push({ deploymentId: id, from, to, reason });
    return true;
  }

  async promote(id: string): Promise<boolean> {
    const target = this.deployments.get(id);
    if (!target || target.status !== "HealthChecking") return false;

    for (const other of this.deployments.values()) {
      if (other.serviceInstanceId === target.serviceInstanceId && other.status === "Running" && other.id !== id) {
        other.status = "Superseded";
        this.events.push({ deploymentId: other.id, from: "Running", to: "Superseded", reason: `superseded by ${id}` });
      }
    }
    target.status = "Running";
    this.events.push({ deploymentId: id, from: "HealthChecking", to: "Running" });
    return true;
  }
}
