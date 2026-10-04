import type { DecommissionEnvironmentRecord, DecommissionStore } from "./store.js";

interface EnvRow extends DecommissionEnvironmentRecord {
  deletedAt: Date | null;
}

interface InstanceRow {
  id: string;
  environmentId: string;
  deletedAt: Date | null;
}

// In-memory store for tests. Same contract as Postgres, including that a deleted environment or
// instance no longer shows up in reads.
export class InMemoryDecommissionStore implements DecommissionStore {
  private readonly envs = new Map<string, EnvRow>();
  private readonly instances = new Map<string, InstanceRow>();
  readonly domainsDeleted: string[] = [];

  addEnvironment(env: Pick<DecommissionEnvironmentRecord, "id" | "projectId"> & { ttlAt?: Date | null }): void {
    this.envs.set(env.id, { id: env.id, projectId: env.projectId, ttlAt: env.ttlAt ?? null, deletedAt: null });
  }

  addServiceInstance(instance: { id: string; environmentId: string }): void {
    this.instances.set(instance.id, { ...instance, deletedAt: null });
  }

  async listExpired(now: Date): Promise<DecommissionEnvironmentRecord[]> {
    return [...this.envs.values()]
      .filter((e) => !e.deletedAt && e.ttlAt !== null && e.ttlAt.getTime() <= now.getTime())
      .map((e) => ({ id: e.id, projectId: e.projectId, ttlAt: e.ttlAt }));
  }

  async findEnvironment(environmentId: string): Promise<DecommissionEnvironmentRecord | null> {
    const env = this.envs.get(environmentId);
    if (!env || env.deletedAt) return null;
    return { id: env.id, projectId: env.projectId, ttlAt: env.ttlAt };
  }

  async listServiceInstanceIds(environmentId: string): Promise<string[]> {
    return [...this.instances.values()]
      .filter((i) => i.environmentId === environmentId && !i.deletedAt)
      .map((i) => i.id);
  }

  async deleteDomains(serviceInstanceId: string): Promise<void> {
    this.domainsDeleted.push(serviceInstanceId);
  }

  async markServiceInstanceDeleted(serviceInstanceId: string): Promise<void> {
    const instance = this.instances.get(serviceInstanceId);
    if (instance) instance.deletedAt = new Date();
  }

  async markEnvironmentDeleted(environmentId: string): Promise<void> {
    const env = this.envs.get(environmentId);
    if (env) env.deletedAt = new Date();
  }

  // Read for the tests.
  isEnvironmentDeleted(environmentId: string): boolean {
    return this.envs.get(environmentId)?.deletedAt != null;
  }
}
