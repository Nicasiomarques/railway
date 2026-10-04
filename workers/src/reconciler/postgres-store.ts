import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { buildLogs, deploymentEvents, deployments, serviceInstances, services, type Db } from "@railway-like/db";
import type { DeploymentStatus } from "@railway-like/shared";
import type { DeploymentRecord, DeploymentStore } from "./store.js";
import { PermanentError } from "./errors.js";

// Resolves the deployment's snapshot variables. Injected because the snapshot is encrypted
// and the envelope key isn't this module's responsibility.
export type LoadEnv = (envSnapshotId: string | null) => Promise<Record<string, string>>;

// Reconciler's Postgres store. Every status write also records the event in deployment_events,
// in the same transaction.
export class PostgresDeploymentStore implements DeploymentStore {
  constructor(
    private readonly db: Db,
    private readonly loadEnv: LoadEnv,
  ) {}

  async findActive(serviceInstanceId: string): Promise<DeploymentRecord | null> {
    const [row] = await this.db
      .select({
        deployment: deployments,
        replicas: serviceInstances.replicas,
        environmentId: serviceInstances.environmentId,
        repoUrl: services.repoUrl,
        rootDir: services.rootDir,
        autoscalingEnabled: serviceInstances.autoscalingEnabled,
        minReplicas: serviceInstances.minReplicas,
        maxReplicas: serviceInstances.maxReplicas,
        targetCpuPercent: serviceInstances.targetCpuPercent,
        cpuRequestMillicores: serviceInstances.cpuRequestMillicores,
      })
      .from(deployments)
      .innerJoin(serviceInstances, eq(serviceInstances.id, deployments.serviceInstanceId))
      .innerJoin(services, eq(services.id, serviceInstances.serviceId))
      .where(
        and(
          eq(deployments.serviceInstanceId, serviceInstanceId),
          inArray(deployments.status, ["Queued", "Building", "Deploying", "HealthChecking"]),
        ),
      )
      .orderBy(desc(deployments.versionNo))
      .limit(1);
    if (!row) return null;

    const d = row.deployment;
    return {
      id: d.id,
      serviceInstanceId: d.serviceInstanceId,
      environmentId: row.environmentId,
      versionNo: d.versionNo,
      status: d.status,
      imageDigest: d.imageDigest,
      commitSha: d.commitSha,
      repoUrl: row.repoUrl,
      rootDir: row.rootDir,
      env: await this.loadEnv(d.envSnapshotId).catch((err: unknown) => {
        // Without the deployment id, the reconciler can't mark it as Failed.
        if (err instanceof PermanentError) throw new PermanentError(err.message, d.id);
        throw err;
      }),
      replicas: row.replicas,
      autoscaling:
        row.autoscalingEnabled &&
        row.minReplicas !== null &&
        row.maxReplicas !== null &&
        row.targetCpuPercent !== null &&
        row.cpuRequestMillicores !== null
          ? {
              minReplicas: row.minReplicas,
              maxReplicas: row.maxReplicas,
              targetCpuPercent: row.targetCpuPercent,
              cpuRequestMillicores: row.cpuRequestMillicores,
            }
          : null,
    };
  }

  async saveBuildLog(id: string, content: string): Promise<void> {
    await this.db
      .insert(buildLogs)
      .values({ deploymentId: id, content, updatedAt: new Date() })
      .onConflictDoUpdate({ target: buildLogs.deploymentId, set: { content, updatedAt: new Date() } });
  }

  async setImageDigest(id: string, imageDigest: string): Promise<boolean> {
    const updated = await this.db
      .update(deployments)
      .set({ imageDigest, updatedAt: new Date() })
      .where(and(eq(deployments.id, id), sql`${deployments.imageDigest} is null`))
      .returning({ id: deployments.id });
    return updated.length > 0;
  }

  async setStatus(id: string, from: DeploymentStatus, to: DeploymentStatus, reason?: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(deployments)
        .set({ status: to, updatedAt: new Date() })
        .where(and(eq(deployments.id, id), eq(deployments.status, from)))
        .returning({ id: deployments.id });
      if (updated.length === 0) return false;

      await tx.insert(deploymentEvents).values({ deploymentId: id, fromStatus: from, toStatus: to, reason });
      return true;
    });
  }

  async promote(id: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [target] = await tx
        .select({ serviceInstanceId: deployments.serviceInstanceId, status: deployments.status })
        .from(deployments)
        .where(eq(deployments.id, id));
      if (!target || target.status !== "HealthChecking") return false;

      // Locks the instance: two concurrent promotions of the same instance can't leave two Running.
      await tx.select({ id: serviceInstances.id }).from(serviceInstances).where(eq(serviceInstances.id, target.serviceInstanceId)).for("update");

      const superseded = await tx
        .update(deployments)
        .set({ status: "Superseded", updatedAt: new Date() })
        .where(
          and(
            eq(deployments.serviceInstanceId, target.serviceInstanceId),
            eq(deployments.status, "Running"),
            ne(deployments.id, id),
          ),
        )
        .returning({ id: deployments.id });
      for (const previous of superseded) {
        await tx.insert(deploymentEvents).values({
          deploymentId: previous.id,
          fromStatus: "Running",
          toStatus: "Superseded",
          reason: `superseded by ${id}`,
        });
      }

      await tx.update(deployments).set({ status: "Running", updatedAt: new Date() }).where(eq(deployments.id, id));
      await tx.insert(deploymentEvents).values({ deploymentId: id, fromStatus: "HealthChecking", toStatus: "Running" });
      return true;
    });
  }
}
