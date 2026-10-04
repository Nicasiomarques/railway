import { and, eq, isNull, lte } from "drizzle-orm";
import { domains, environments, serviceInstances, type Db } from "@railway-like/db";
import type { DecommissionEnvironmentRecord, DecommissionStore } from "./store.js";

// Postgres store for the decommission worker. Mirrors PostgresEnvironmentStore
// (../provisioning/postgres-store.ts): the saga state it reads/writes lives on the same
// `environments` row the provisioning saga uses, just the ttl_at/deleted_at columns instead of
// provisioning_status/provisioning_steps.
export class PostgresDecommissionStore implements DecommissionStore {
  constructor(private readonly db: Db) {}

  async listExpired(now: Date): Promise<DecommissionEnvironmentRecord[]> {
    const rows = await this.db
      .select({ id: environments.id, projectId: environments.projectId, ttlAt: environments.ttlAt })
      .from(environments)
      // `lte` against a NULL ttl_at evaluates to NULL in SQL, not true: an environment with no TTL
      // is excluded without a separate isNotNull check.
      .where(and(isNull(environments.deletedAt), lte(environments.ttlAt, now)));
    return rows;
  }

  async findEnvironment(environmentId: string): Promise<DecommissionEnvironmentRecord | null> {
    const [row] = await this.db
      .select({ id: environments.id, projectId: environments.projectId, ttlAt: environments.ttlAt })
      .from(environments)
      .where(and(eq(environments.id, environmentId), isNull(environments.deletedAt)))
      .limit(1);
    return row ?? null;
  }

  async listServiceInstanceIds(environmentId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: serviceInstances.id })
      .from(serviceInstances)
      .where(and(eq(serviceInstances.environmentId, environmentId), isNull(serviceInstances.deletedAt)));
    return rows.map((r) => r.id);
  }

  async deleteDomains(serviceInstanceId: string): Promise<void> {
    await this.db.delete(domains).where(eq(domains.serviceInstanceId, serviceInstanceId));
  }

  async markServiceInstanceDeleted(serviceInstanceId: string): Promise<void> {
    await this.db
      .update(serviceInstances)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(serviceInstances.id, serviceInstanceId));
  }

  async markEnvironmentDeleted(environmentId: string): Promise<void> {
    await this.db
      .update(environments)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(environments.id, environmentId));
  }
}
