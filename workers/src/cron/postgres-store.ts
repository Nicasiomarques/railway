import { and, desc, eq, isNull } from "drizzle-orm";
import { deploymentEvents, deployments, serviceInstances, services, type Db } from "@railway-like/db";
import type { CronInstance, CronStore, TriggerCronResult } from "./store.js";

export class PostgresCronStore implements CronStore {
  constructor(private readonly db: Db) {}

  async listCronInstances(): Promise<CronInstance[]> {
    const rows = await this.db
      .select({ id: serviceInstances.id, schedule: serviceInstances.schedule })
      .from(serviceInstances)
      .innerJoin(services, eq(services.id, serviceInstances.serviceId))
      .where(and(eq(services.kind, "cron"), isNull(serviceInstances.deletedAt), isNull(services.deletedAt)));

    // `schedule` is nullable at the column level (only meaningful for kind "cron"); a cron service
    // without one yet just isn't scheduled.
    return rows
      .filter((r): r is { id: string; schedule: string } => r.schedule !== null)
      .map((r) => ({ serviceInstanceId: r.id, schedule: r.schedule }));
  }

  async triggerRun(serviceInstanceId: string): Promise<TriggerCronResult> {
    return this.db.transaction(async (tx) => {
      // Locks the instance: versions are sequential, same as createQueuedDeployment's own lock.
      const [instance] = await tx
        .select({ id: serviceInstances.id })
        .from(serviceInstances)
        .where(eq(serviceInstances.id, serviceInstanceId))
        .for("update");
      if (!instance) return { kind: "instance_not_found" };

      const [previous] = await tx
        .select()
        .from(deployments)
        .where(eq(deployments.serviceInstanceId, serviceInstanceId))
        .orderBy(desc(deployments.versionNo))
        .limit(1);
      if (!previous) return { kind: "no_previous_deployment" };

      const versionNo = previous.versionNo + 1;
      const [created] = await tx
        .insert(deployments)
        .values({
          serviceInstanceId,
          versionNo,
          status: "Queued",
          trigger: "cron",
          imageDigest: previous.imageDigest,
          commitSha: previous.commitSha,
          branch: previous.branch,
          author: previous.author,
          // Reuses the previous immutable snapshot: a scheduled run doesn't change config, only re-runs it.
          envSnapshotId: previous.envSnapshotId,
        })
        .returning();
      await tx.insert(deploymentEvents).values({
        deploymentId: created.id,
        fromStatus: null,
        toStatus: "Queued",
        reason: "cron trigger",
      });

      return { kind: "queued", versionNo };
    });
  }
}
