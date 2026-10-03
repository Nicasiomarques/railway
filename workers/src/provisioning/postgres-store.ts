import { and, eq, isNull, sql } from "drizzle-orm";
import { environments, type Db } from "@railway-like/db";
import type { EnvironmentProvisioningStore, EnvironmentRecord, ProvisioningStep } from "./saga.js";

// Saga state in environments (provisioning_status, provisioning_steps, provisioning_error).
export class PostgresEnvironmentStore implements EnvironmentProvisioningStore {
  constructor(private readonly db: Db) {}

  async findEnvironment(environmentId: string): Promise<EnvironmentRecord | null> {
    const [row] = await this.db
      .select({
        id: environments.id,
        projectId: environments.projectId,
        status: environments.provisioningStatus,
        completedSteps: environments.provisioningSteps,
      })
      .from(environments)
      .where(and(eq(environments.id, environmentId), isNull(environments.deletedAt)))
      .limit(1);
    return row ?? null;
  }

  async markProvisioning(environmentId: string): Promise<void> {
    await this.update(environmentId, { provisioningStatus: "provisioning" });
  }

  // Appends only if the step isn't already in the list: writing it again doesn't duplicate the record.
  async markStepDone(environmentId: string, step: ProvisioningStep): Promise<void> {
    await this.db
      .update(environments)
      .set({
        provisioningSteps: sql`${environments.provisioningSteps} || to_jsonb(${step}::text)`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(environments.id, environmentId),
          sql`NOT (${environments.provisioningSteps} ? ${step})`,
        ),
      );
  }

  async recordError(environmentId: string, reason: string): Promise<void> {
    await this.update(environmentId, { provisioningError: reason });
  }

  async markReady(environmentId: string): Promise<void> {
    await this.update(environmentId, { provisioningStatus: "ready", provisioningError: null });
  }

  async markFailed(environmentId: string, reason: string): Promise<void> {
    await this.update(environmentId, { provisioningStatus: "failed", provisioningError: reason });
  }

  private async update(
    environmentId: string,
    values: Partial<typeof environments.$inferInsert>,
  ): Promise<void> {
    await this.db
      .update(environments)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(environments.id, environmentId));
  }
}
