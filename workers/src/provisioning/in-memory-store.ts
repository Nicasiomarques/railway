import type { EnvironmentProvisioningStore, EnvironmentRecord, ProvisioningStatus, ProvisioningStep } from "./saga.js";

// In-memory saga store, for tests. Same contract as Postgres: completed steps don't repeat.
export class InMemoryEnvironmentStore implements EnvironmentProvisioningStore {
  private readonly envs = new Map<string, EnvironmentRecord & { error: string | null }>();

  add(env: Omit<EnvironmentRecord, "status" | "completedSteps"> & Partial<Pick<EnvironmentRecord, "status" | "completedSteps">>): void {
    this.envs.set(env.id, { status: "pending", completedSteps: [], error: null, ...env });
  }

  async findEnvironment(environmentId: string): Promise<EnvironmentRecord | null> {
    const env = this.envs.get(environmentId);
    return env ? { ...env, completedSteps: [...env.completedSteps] } : null;
  }

  async markProvisioning(environmentId: string): Promise<void> {
    this.require(environmentId).status = "provisioning";
  }

  async markStepDone(environmentId: string, step: ProvisioningStep): Promise<void> {
    const env = this.require(environmentId);
    if (!env.completedSteps.includes(step)) env.completedSteps.push(step);
  }

  async recordError(environmentId: string, reason: string): Promise<void> {
    this.require(environmentId).error = reason;
  }

  async markReady(environmentId: string): Promise<void> {
    this.setStatus(environmentId, "ready");
  }

  async markFailed(environmentId: string, reason: string): Promise<void> {
    const env = this.require(environmentId);
    env.status = "failed";
    env.error = reason;
  }

  // Read for the tests.
  snapshot(environmentId: string): (EnvironmentRecord & { error: string | null }) | undefined {
    const env = this.envs.get(environmentId);
    return env && { ...env, completedSteps: [...env.completedSteps] };
  }

  private setStatus(environmentId: string, status: ProvisioningStatus): void {
    this.require(environmentId).status = status;
  }

  private require(environmentId: string) {
    const env = this.envs.get(environmentId);
    if (!env) throw new Error(`environment ${environmentId} does not exist`);
    return env;
  }
}
