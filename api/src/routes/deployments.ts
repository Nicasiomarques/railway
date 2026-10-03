import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { type DeploymentStatus, transition } from "@railway-like/shared";
import { requireInstanceAccess } from "../access.js";
import { sealEnvSnapshot, type Keyring } from "../crypto/envelope.js";
import { ApiError } from "../errors.js";
import { runIdempotent } from "../idempotency.js";
import { resolveInstanceEnv } from "../env/resolve.js";
import type { DeploymentQueue } from "../queue.js";
import type { Db } from "../db/client.js";
import { auditLogs, buildLogs, deploymentEvents, deployments, envSnapshots, serviceInstances, services } from "../db/schema.js";
import { BuildLogSchema, DeploymentDetailSchema, DeploymentSchema, listOf } from "../openapi/schemas.js";
import { idempotencyKeyHeader } from "./headers.js";

const instanceParams = z.object({ instanceId: z.string().uuid() });
const deploymentParams = z.object({ deploymentId: z.string().uuid() });

// Exactly one of the two sources: a ready-made image by digest, or a commit from a repo that the cluster builds.
// Which one is required depends on the service's source, and that is checked in the route.
export const createDeploymentBody = z
  .object({
    imageDigest: z
      .string()
      .regex(/^[a-z0-9]+(?:[._/-][a-z0-9]+)*@sha256:[a-f0-9]{64}$/, "use an image by digest: repo@sha256:<64 hex>")
      .optional(),
    commitSha: z.string().regex(/^[a-f0-9]{40}$/, "use the full commit SHA (40 hex)").optional(),
  })
  .superRefine((body, ctx) => {
    if (!body.imageDigest && !body.commitSha) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "provide imageDigest or commitSha" });
    }
    if (body.imageDigest && body.commitSha) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "provide only one: imageDigest or commitSha" });
    }
  });

const listDeploymentsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// States in which a deployment can still become Running. Creating another one cancels these.
const IN_FLIGHT: DeploymentStatus[] = ["Queued", "Building", "Deploying", "HealthChecking"];

type DeploymentRow = typeof deployments.$inferSelect;

function toResponse(d: DeploymentRow) {
  return {
    id: d.id,
    serviceInstanceId: d.serviceInstanceId,
    versionNo: d.versionNo,
    status: d.status,
    trigger: d.trigger,
    imageDigest: d.imageDigest,
    commitSha: d.commitSha,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

export const deploymentRoutes: FastifyPluginAsync<{ db: Db; keyring: Keyring; queue?: DeploymentQueue }> = async (
  app,
  { db, keyring, queue },
) => {
  app.post(
    "/services/:instanceId/deployments",
    {
      config: {
        openapi: {
          operationId: "createDeployment",
          tags: ["Deployments"],
          summary: "Creates a deployment from an image by digest; the env snapshot is saved now",
          pathSchema: instanceParams,
          bodySchema: createDeploymentBody,
          idempotent: true,
          success: { status: 202, description: "Deployment queued", schema: DeploymentSchema },
          errors: [403, 404, 422, 503],
        },
      },
    },
    async (request, reply) => {
      const { instanceId } = instanceParams.parse(request.params);
      const body = createDeploymentBody.parse(request.body);
      const userId = request.auth!.userId;
      const { organizationId } = await requireInstanceAccess(db, userId, instanceId, { write: true });

      const [source] = await db
        .select({ source: services.source })
        .from(serviceInstances)
        .innerJoin(services, eq(services.id, serviceInstances.serviceId))
        .where(eq(serviceInstances.id, instanceId));
      if (source.source === "github_repo" && !body.commitSha) {
        throw new ApiError(400, "source_mismatch", "A github_repo service requires commitSha, not imageDigest.");
      }
      if (source.source !== "github_repo" && !body.imageDigest) {
        throw new ApiError(400, "source_mismatch", "This service requires imageDigest, not commitSha.");
      }

      // Filled inside the transaction; used only after the commit (on a retry it stays empty, and doesn't need to be used).
      const cancelledIds: string[] = [];
      const result = await runIdempotent(db, {
        userId,
        key: idempotencyKeyHeader(request.headers),
        payload: { instanceId, ...body },
        run: async (tx) => {
          // Locks the instance: versions are sequential, and two concurrent creations must not repeat one.
          const [locked] = await tx
            .select({ id: serviceInstances.id })
            .from(serviceInstances)
            .where(eq(serviceInstances.id, instanceId))
            .for("update");
          if (!locked) throw new ApiError(404, "instance_not_found", "Instance not found.");

          const [{ last }] = await tx
            .select({ last: sql<number>`coalesce(max(${deployments.versionNo}), 0)::int` })
            .from(deployments)
            .where(eq(deployments.serviceInstanceId, instanceId));
          const versionNo = last + 1;

          // Immutable snapshot: a rollback returns to this set, not to the variables' current state.
          const env = await resolveInstanceEnv(tx, keyring, instanceId);
          const snapshotId = randomUUID();
          await tx.insert(envSnapshots).values({
            id: snapshotId,
            serviceInstanceId: instanceId,
            payloadEnc: sealEnvSnapshot(keyring, snapshotId, Object.fromEntries(env.map((v) => [v.key, v.value]))),
          });

          // The new deployment supersedes the ones still in flight (architecture.md §5.2, step 3).
          const inFlight = await tx
            .select({ id: deployments.id, status: deployments.status })
            .from(deployments)
            .where(and(eq(deployments.serviceInstanceId, instanceId), inArray(deployments.status, IN_FLIGHT)));
          for (const old of inFlight) {
            transition(old.status, "Cancelled");
            await tx.update(deployments).set({ status: "Cancelled", updatedAt: new Date() }).where(eq(deployments.id, old.id));
            await tx.insert(deploymentEvents).values({
              deploymentId: old.id,
              fromStatus: old.status,
              toStatus: "Cancelled",
              reason: `superseded by version ${versionNo}`,
            });
            cancelledIds.push(old.id);
          }

          const [created] = await tx
            .insert(deployments)
            .values({
              serviceInstanceId: instanceId,
              versionNo,
              status: "Queued",
              trigger: "manual",
              imageDigest: body.imageDigest ?? null,
              commitSha: body.commitSha ?? null,
              envSnapshotId: snapshotId,
            })
            .returning();
          await tx.insert(deploymentEvents).values({ deploymentId: created.id, fromStatus: null, toStatus: "Queued", reason: "created" });
          await tx.insert(auditLogs).values({
            organizationId,
            actorId: userId,
            action: "deployment.create",
            target: `deployment:${created.id}`,
          });
          return { status: 202, body: toResponse(created) };
        },
      });

      // Enqueues after the commit: the worker needs to see the row. Retrying with the same Idempotency-Key
      // enqueues again; the jobId per version deduplicates, and the reconciler is idempotent.
      const dep = result.body as ReturnType<typeof toResponse>;
      try {
        if (!queue) throw new Error("deployment queue not configured");
        await queue.enqueueReconcile({ serviceInstanceId: dep.serviceInstanceId, versionNo: dep.versionNo });
      } catch {
        // Without a job the deployment would stay Queued forever. Marks it as Failed so the state reflects reality.
        await db.transaction(async (tx) => {
          const updated = await tx
            .update(deployments)
            .set({ status: "Failed", updatedAt: new Date() })
            .where(and(eq(deployments.id, dep.id), eq(deployments.status, "Queued")))
            .returning({ id: deployments.id });
          if (updated.length > 0) {
            await tx.insert(deploymentEvents).values({
              deploymentId: dep.id,
              fromStatus: "Queued",
              toStatus: "Failed",
              reason: "failed to enqueue",
            });
          }
        });
        throw new ApiError(
          503,
          "queue_unavailable",
          "Could not enqueue the deployment; it was marked as Failed. Create a new one.",
        );
      }

      // Deletes the builds of the deployments this version superseded. Best effort: if it fails, the Job dies via timeout.
      for (const id of cancelledIds) {
        await queue?.enqueueCancelBuild({ deploymentId: id, serviceInstanceId: instanceId }).catch(() => undefined);
      }

      return reply.code(result.status).send(result.body);
    },
  );

  app.get(
    "/services/:instanceId/deployments",
    {
      config: {
        openapi: {
          operationId: "listDeployments",
          tags: ["Deployments"],
          summary: "Lists an instance's deployments, from most recent to oldest",
          pathSchema: instanceParams,
          querySchema: listDeploymentsQuery,
          success: { status: 200, description: "Deployments", schema: listOf(DeploymentSchema) },
          errors: [404],
        },
      },
    },
    async (request) => {
      const { instanceId } = instanceParams.parse(request.params);
      const query = listDeploymentsQuery.parse(request.query);
      await requireInstanceAccess(db, request.auth!.userId, instanceId);

      const rows = await db
        .select()
        .from(deployments)
        .where(eq(deployments.serviceInstanceId, instanceId))
        .orderBy(desc(deployments.versionNo))
        .limit(query.limit);
      return { data: rows.map(toResponse) };
    },
  );

  app.get(
    "/deployments/:deploymentId",
    {
      config: {
        openapi: {
          operationId: "getDeployment",
          tags: ["Deployments"],
          summary: "Shows a deployment's details along with its state history",
          pathSchema: deploymentParams,
          success: { status: 200, description: "Deployment", schema: DeploymentDetailSchema },
          errors: [404],
        },
      },
    },
    async (request) => {
      const { deploymentId } = deploymentParams.parse(request.params);
      const [dep] = await db.select().from(deployments).where(eq(deployments.id, deploymentId));
      // No access and nonexistent return the same error: it doesn't reveal that the id exists.
      const notFound = () => new ApiError(404, "deployment_not_found", "Deployment not found.");
      if (!dep) throw notFound();
      await requireInstanceAccess(db, request.auth!.userId, dep.serviceInstanceId).catch(() => {
        throw notFound();
      });

      const events = await db
        .select()
        .from(deploymentEvents)
        .where(eq(deploymentEvents.deploymentId, deploymentId))
        .orderBy(deploymentEvents.occurredAt, deploymentEvents.id);
      return {
        ...toResponse(dep),
        events: events.map((e) => ({ fromStatus: e.fromStatus, toStatus: e.toStatus, reason: e.reason, occurredAt: e.occurredAt })),
      };
    },
  );

  // Cancels a deployment that hasn't reached Running yet. Running only exits via supersession (see architecture §5.2).
  app.post(
    "/deployments/:deploymentId/cancel",
    {
      config: {
        openapi: {
          operationId: "cancelDeployment",
          tags: ["Deployments"],
          summary: "Cancels a deployment that isn't Running yet; the build in progress is deleted",
          pathSchema: deploymentParams,
          success: { status: 200, description: "Deployment cancelled", schema: DeploymentSchema },
          errors: [403, 404, 409],
        },
      },
    },
    async (request) => {
      const { deploymentId } = deploymentParams.parse(request.params);
      const notFound = () => new ApiError(404, "deployment_not_found", "Deployment not found.");
      const [dep] = await db.select().from(deployments).where(eq(deployments.id, deploymentId));
      if (!dep) throw notFound();

      const access = await requireInstanceAccess(db, request.auth!.userId, dep.serviceInstanceId, { write: true }).catch((err) => {
        if (err instanceof ApiError && err.status === 403) throw err;
        throw notFound();
      });

      if (!IN_FLIGHT.includes(dep.status)) {
        throw new ApiError(409, "not_cancellable", `A deployment in ${dep.status} cannot be cancelled.`);
      }

      const [cancelled] = await db.transaction(async (tx) => {
        transition(dep.status, "Cancelled");
        // Conditioned on the status we read: if the worker advanced in the meantime, the write doesn't happen.
        const rows = await tx
          .update(deployments)
          .set({ status: "Cancelled", updatedAt: new Date() })
          .where(and(eq(deployments.id, deploymentId), eq(deployments.status, dep.status)))
          .returning();
        if (rows.length === 0) throw new ApiError(409, "state_changed", "The deployment's state changed; try again.");

        await tx.insert(deploymentEvents).values({
          deploymentId,
          fromStatus: dep.status,
          toStatus: "Cancelled",
          reason: "cancelled by user",
        });
        await tx.insert(auditLogs).values({
          organizationId: access.organizationId,
          actorId: request.auth!.userId,
          action: "deployment.cancel",
          target: `deployment:${deploymentId}`,
        });
        return rows;
      });

      // Always enqueues: the worker deletes the Job if there is one and ignores it if there isn't (images have no Job).
      await queue?.enqueueCancelBuild({ deploymentId, serviceInstanceId: dep.serviceInstanceId }).catch((err) => {
        request.log.warn({ err, deploymentId }, "build cancellation not enqueued; the Job will expire via timeout");
      });
      return toResponse(cancelled);
    },
  );

  // Latest snapshot of the build logs. Empty while the build hasn't started (or for image deployments).
  app.get(
    "/deployments/:deploymentId/logs",
    {
      config: {
        openapi: {
          operationId: "getDeploymentLogs",
          tags: ["Deployments"],
          summary: "The deployment's build logs (gate, clone and build); the content is the last saved snapshot",
          pathSchema: deploymentParams,
          success: { status: 200, description: "Logs", schema: BuildLogSchema },
          errors: [404],
        },
      },
    },
    async (request) => {
      const { deploymentId } = deploymentParams.parse(request.params);
      const notFound = () => new ApiError(404, "deployment_not_found", "Deployment not found.");
      const [dep] = await db.select({ serviceInstanceId: deployments.serviceInstanceId }).from(deployments).where(eq(deployments.id, deploymentId));
      if (!dep) throw notFound();
      await requireInstanceAccess(db, request.auth!.userId, dep.serviceInstanceId).catch(() => {
        throw notFound();
      });

      const [row] = await db.select().from(buildLogs).where(eq(buildLogs.deploymentId, deploymentId));
      return { content: row?.content ?? "", updatedAt: row?.updatedAt ?? null };
    },
  );
};
