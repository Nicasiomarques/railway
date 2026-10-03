import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
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
import { BuildLogSchema, DeploymentDetailSchema, DeploymentSchema, MetricsSnapshotSchema, listOf } from "../openapi/schemas.js";
import { namespaceFor, workloadName, type RuntimeReader } from "../runtime.js";
import { idempotencyKeyHeader } from "./headers.js";

const instanceParams = z.object({ instanceId: z.string().uuid() });
const deploymentParams = z.object({ deploymentId: z.string().uuid() });

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// Without `stream`: a JSON snapshot of the build (compatible with this route's previous behavior).
// `stream=build|runtime`: the same route starts responding over SSE (architecture.md §9, §10).
const deploymentLogsQuery = z.object({
  stream: z.enum(["build", "runtime"]).optional(),
  // Only applies to `stream=runtime`: an RFC3339 timestamp from which to show runtime logs.
  since: z.string().optional(),
});

const metricsQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  metric: z.string().optional(),
});

// In-progress builds: while the deployment is in one of these states, the build tail keeps reopening.
const BUILD_IN_PROGRESS: DeploymentStatus[] = ["Queued", "Building"];
const BUILD_LOG_POLL_MS = 500;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => resolve(), { once: true });
    // Don't let a lone live timer delay process exit in tests.
    (timer as { unref?: () => void }).unref?.();
  });
}

// Tails the `build_logs` snapshot saved by the reconciler (see captureBuildLogs in workers/reconciler).
// No real append: polls the same row and sends only the new lines; closes once the build finishes.
async function* tailBuildLog(db: Db, deploymentId: string, signal: AbortSignal): AsyncIterable<string> {
  let sent = 0;
  while (!signal.aborted) {
    const [row] = await db.select({ content: buildLogs.content }).from(buildLogs).where(eq(buildLogs.deploymentId, deploymentId));
    const lines = row?.content ? row.content.split("\n") : [];
    for (; sent < lines.length && !signal.aborted; sent++) yield lines[sent];

    const [dep] = await db.select({ status: deployments.status }).from(deployments).where(eq(deployments.id, deploymentId));
    if (!dep || !BUILD_IN_PROGRESS.includes(dep.status)) return;
    await sleep(BUILD_LOG_POLL_MS, signal);
  }
}

// Writes an AsyncIterable<string> as SSE (`data: <line>\n\n` per line) and closes on finish or disconnect.
async function sendSse(request: FastifyRequest, reply: FastifyReply, lines: AsyncIterable<string>): Promise<void> {
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  try {
    for await (const line of lines) {
      if (request.signal.aborted) break;
      reply.raw.write(`data: ${line}\n\n`);
    }
  } finally {
    reply.raw.end();
  }
}

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
type DeploymentTrigger = DeploymentRow["trigger"];

// Core of deployment creation (architecture.md §5.2, steps 2-3): versions it, saves the env
// snapshot and cancels whatever was in flight on the same instance. Used by the manual route
// (below) and by the GitHub push webhook (routes/github.ts) — the only difference between the
// two origins is the trigger and the commit/branch/author fields.
export async function createQueuedDeployment(
  tx: Tx,
  keyring: Keyring,
  input: {
    instanceId: string;
    trigger: DeploymentTrigger;
    imageDigest?: string | null;
    commitSha?: string | null;
    branch?: string | null;
    author?: string | null;
    // Rollback (architecture.md §5.2) must restore the EnvSnapshot of the version it targets, not the
    // instance's current variables — that's what makes it a rollback instead of a redeploy. Passing an
    // existing snapshot id here reuses it verbatim instead of resolving+persisting a new one; omitting
    // it (manual creation, GitHub push) keeps the original behavior of snapshotting the current env.
    envSnapshotId?: string | null;
    // Set only for a rollback: the deployment it is reverting to (`rollback_of_id`).
    rollbackOfId?: string | null;
  },
): Promise<{ created: DeploymentRow; cancelledIds: string[] }> {
  const { instanceId } = input;

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

  // Immutable snapshot: a rollback returns to this set, not to the variables' current state. When
  // `envSnapshotId` is given (rollback), reuse that snapshot instead of resolving the current env.
  let snapshotId: string;
  if (input.envSnapshotId) {
    snapshotId = input.envSnapshotId;
  } else {
    const env = await resolveInstanceEnv(tx, keyring, instanceId);
    snapshotId = randomUUID();
    await tx.insert(envSnapshots).values({
      id: snapshotId,
      serviceInstanceId: instanceId,
      payloadEnc: sealEnvSnapshot(keyring, snapshotId, Object.fromEntries(env.map((v) => [v.key, v.value]))),
    });
  }

  // The new deployment supersedes the ones still in flight (architecture.md §5.2, step 3).
  const inFlight = await tx
    .select({ id: deployments.id, status: deployments.status })
    .from(deployments)
    .where(and(eq(deployments.serviceInstanceId, instanceId), inArray(deployments.status, IN_FLIGHT)));
  const cancelledIds: string[] = [];
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
      trigger: input.trigger,
      imageDigest: input.imageDigest ?? null,
      commitSha: input.commitSha ?? null,
      branch: input.branch ?? null,
      author: input.author ?? null,
      envSnapshotId: snapshotId,
      rollbackOfId: input.rollbackOfId ?? null,
    })
    .returning();
  await tx.insert(deploymentEvents).values({ deploymentId: created.id, fromStatus: null, toStatus: "Queued", reason: "created" });

  return { created, cancelledIds };
}

function toResponse(d: DeploymentRow) {
  return {
    id: d.id,
    serviceInstanceId: d.serviceInstanceId,
    versionNo: d.versionNo,
    status: d.status,
    trigger: d.trigger,
    imageDigest: d.imageDigest,
    commitSha: d.commitSha,
    rollbackOfId: d.rollbackOfId,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

export const deploymentRoutes: FastifyPluginAsync<{ db: Db; keyring: Keyring; queue?: DeploymentQueue; runtime?: RuntimeReader }> = async (
  app,
  { db, keyring, queue, runtime },
) => {
  // Shared by the manual-create and rollback routes: enqueues the reconciler job for a freshly
  // created Queued deployment, and if that fails, marks it Failed instead of leaving it stuck
  // forever (the worker will never see a job for it). Enqueuing after the commit is required: the
  // worker reads the row, so it must already be visible.
  async function enqueueReconcileOrFail(dep: Pick<DeploymentRow, "id" | "serviceInstanceId" | "versionNo">): Promise<void> {
    try {
      if (!queue) throw new Error("deployment queue not configured");
      await queue.enqueueReconcile({ serviceInstanceId: dep.serviceInstanceId, versionNo: dep.versionNo });
    } catch {
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
  }

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
          const { created, cancelledIds: cancelled } = await createQueuedDeployment(tx, keyring, {
            instanceId,
            trigger: "manual",
            imageDigest: body.imageDigest ?? null,
            commitSha: body.commitSha ?? null,
          });
          cancelledIds.push(...cancelled);
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
      await enqueueReconcileOrFail(dep);

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

  // Rolls back to a previous version: a new deployment (trigger "rollback") reusing that version's
  // image/commit and EnvSnapshot verbatim — no rebuild (architecture.md §5.2, §10). `:deploymentId`
  // here is the deployment to roll back TO; the new rollback deployment lands as the latest version
  // on the same instance, same as the manual-create route.
  //
  // Registered as "/deployments/:deploymentId([^:]+)::rollback", not ".../:deploymentId/rollback",
  // to match the CLI's literal call to POST /v1/deployments/{id}:rollback (architecture.md §10: actions
  // as `:verb` when they aren't CRUD). Verified with app.inject (see deployments.test.ts): Fastify/
  // find-my-way treats a bare second ":" right after a param as the start of *another* param, so
  // ":deploymentId:rollback" doesn't split into {deploymentId}+"rollback" — it swallows the whole
  // ":rollback" suffix into deploymentId's matched value. Constraining the param with a regex
  // ("([^:]+)", i.e. "not a colon") stops it from crossing that boundary, and the trailing "::" is
  // find-my-way's own escape sequence for a literal single ":" in the URL. toOpenApiPath
  // (openapi/index.ts) knows this convention and renders the documented path as
  // "/v1/deployments/{deploymentId}:rollback".
  //
  // Idempotency: no Idempotency-Key here, unlike the manual-create route. Retrying a rollback just
  // creates another rollback deployment (another version, same image/snapshot) — that's an acceptable,
  // observable side effect for a POST with no body to dedupe by, not a correctness bug, so the extra
  // mechanism didn't seem worth it.
  app.post(
    "/deployments/:deploymentId([^:]+)::rollback",
    {
      config: {
        openapi: {
          operationId: "rollbackDeployment",
          tags: ["Deployments"],
          summary: "Rolls back to a previous Running or Superseded version; reuses its image and EnvSnapshot, no rebuild",
          pathSchema: deploymentParams,
          success: { status: 202, description: "Rollback deployment queued", schema: DeploymentSchema },
          errors: [403, 404, 409, 503],
        },
      },
    },
    async (request, reply) => {
      const { deploymentId } = deploymentParams.parse(request.params);
      const notFound = () => new ApiError(404, "deployment_not_found", "Deployment not found.");
      const [target] = await db.select().from(deployments).where(eq(deployments.id, deploymentId));
      if (!target) throw notFound();

      const access = await requireInstanceAccess(db, request.auth!.userId, target.serviceInstanceId, { write: true }).catch((err) => {
        if (err instanceof ApiError && err.status === 403) throw err;
        throw notFound();
      });

      // Mirrors architecture.md §5.2: a rollback target is a previous version that actually ran.
      if (target.status !== "Running" && target.status !== "Superseded") {
        throw new ApiError(
          409,
          "not_rollback_target",
          `Can only roll back to a Running or Superseded version, not ${target.status}.`,
        );
      }

      const cancelledIds: string[] = [];
      const created = await db.transaction(async (tx) => {
        const { created: dep, cancelledIds: cancelled } = await createQueuedDeployment(tx, keyring, {
          instanceId: target.serviceInstanceId,
          trigger: "rollback",
          imageDigest: target.imageDigest,
          commitSha: target.commitSha,
          envSnapshotId: target.envSnapshotId,
          rollbackOfId: target.id,
        });
        cancelledIds.push(...cancelled);
        await tx.insert(auditLogs).values({
          organizationId: access.organizationId,
          actorId: request.auth!.userId,
          action: "deployment.rollback",
          target: `deployment:${dep.id}`,
        });
        return dep;
      });

      await enqueueReconcileOrFail(created);

      // Deletes the builds of the deployments this version superseded. Best effort: if it fails, the Job dies via timeout.
      for (const id of cancelledIds) {
        await queue?.enqueueCancelBuild({ deploymentId: id, serviceInstanceId: target.serviceInstanceId }).catch(() => undefined);
      }

      return reply.code(202).send(toResponse(created));
    },
  );

  // Without `stream`: last snapshot of the build logs (empty before the build starts, or for image deployments).
  // With `stream=build|runtime`: opens an SSE and tails it (architecture.md §9, §10).
  app.get(
    "/deployments/:deploymentId/logs",
    {
      config: {
        openapi: {
          operationId: "getDeploymentLogs",
          tags: ["Deployments", "Observability"],
          summary: "Deployment logs: build snapshot without `stream`, or SSE tail with `stream=build|runtime`",
          pathSchema: deploymentParams,
          querySchema: deploymentLogsQuery,
          success: { status: 200, description: "Logs (JSON without `stream`; `text/event-stream` with `stream`)", schema: BuildLogSchema },
          errors: [404, 503],
        },
      },
    },
    async (request, reply) => {
      const { deploymentId } = deploymentParams.parse(request.params);
      const query = deploymentLogsQuery.parse(request.query);
      const notFound = () => new ApiError(404, "deployment_not_found", "Deployment not found.");
      const [dep] = await db
        .select({ serviceInstanceId: deployments.serviceInstanceId, environmentId: serviceInstances.environmentId })
        .from(deployments)
        .innerJoin(serviceInstances, eq(serviceInstances.id, deployments.serviceInstanceId))
        .where(eq(deployments.id, deploymentId));
      if (!dep) throw notFound();
      await requireInstanceAccess(db, request.auth!.userId, dep.serviceInstanceId).catch(() => {
        throw notFound();
      });

      if (!query.stream) {
        const [row] = await db.select().from(buildLogs).where(eq(buildLogs.deploymentId, deploymentId));
        return { content: row?.content ?? "", updatedAt: row?.updatedAt ?? null };
      }

      if (query.stream === "build") {
        return sendSse(request, reply, tailBuildLog(db, deploymentId, request.signal));
      }

      if (!runtime) throw new ApiError(503, "runtime_unavailable", "No runtime configured on this API.");
      const ref = { name: workloadName(dep.serviceInstanceId), namespace: namespaceFor(dep.environmentId) };
      return sendSse(request, reply, runtime.tailLogs(ref, query.since ? { since: query.since } : undefined));
    },
  );

  // Basic snapshot of the instance's runtime. No real time series in the MVP: `from`/`to`/`metric` only
  // document the contract the architecture foresees (architecture.md §9, §10); the response is always
  // the current state.
  app.get(
    "/services/:instanceId/metrics",
    {
      config: {
        openapi: {
          operationId: "getServiceMetrics",
          tags: ["Observability"],
          summary: "Runtime snapshot of an instance (replicas and state); no time series in the MVP",
          pathSchema: instanceParams,
          querySchema: metricsQuery,
          success: { status: 200, description: "Metrics snapshot", schema: MetricsSnapshotSchema },
          errors: [404, 503],
        },
      },
    },
    async (request) => {
      const { instanceId } = instanceParams.parse(request.params);
      metricsQuery.parse(request.query);
      await requireInstanceAccess(db, request.auth!.userId, instanceId);
      if (!runtime) throw new ApiError(503, "runtime_unavailable", "No runtime configured on this API.");

      const [row] = await db.select({ environmentId: serviceInstances.environmentId }).from(serviceInstances).where(eq(serviceInstances.id, instanceId));
      const ref = { name: workloadName(instanceId), namespace: namespaceFor(row!.environmentId) };
      const status = await runtime.getStatus(ref);

      return {
        instanceId,
        replicas: status?.replicas ?? 0,
        readyReplicas: status?.readyReplicas ?? 0,
        image: status?.image ?? null,
        status: status && status.readyReplicas > 0 ? "running" : "stopped",
      };
    },
  );
};
