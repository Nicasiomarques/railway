import { and, eq, isNull } from "drizzle-orm";
import { serviceInstances, services, usageEvents, type Db } from "@railway-like/db";
import type { UsageInstanceInfo, UsageSample, UsageStore } from "./store.js";

// Postgres store for the usage worker.
export class PostgresUsageStore implements UsageStore {
  constructor(private readonly db: Db) {}

  async getInstance(id: string): Promise<UsageInstanceInfo | null> {
    const [row] = await this.db
      .select({
        id: serviceInstances.id,
        environmentId: serviceInstances.environmentId,
        projectId: services.projectId,
      })
      .from(serviceInstances)
      .innerJoin(services, eq(services.id, serviceInstances.serviceId))
      .where(and(eq(serviceInstances.id, id), isNull(serviceInstances.deletedAt), isNull(services.deletedAt)));
    return row ?? null;
  }

  async recordSample(sample: UsageSample): Promise<void> {
    await this.db.insert(usageEvents).values(sample);
  }

  async listActiveInstanceIds(): Promise<string[]> {
    const rows = await this.db
      .select({ id: serviceInstances.id })
      .from(serviceInstances)
      .innerJoin(services, eq(services.id, serviceInstances.serviceId))
      .where(and(isNull(serviceInstances.deletedAt), isNull(services.deletedAt)));
    return rows.map((r) => r.id);
  }
}
