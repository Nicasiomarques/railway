import { randomBytes } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { EnvironmentSchema, listOf } from "../openapi/schemas.js";
import { requireProjectAccess } from "../access.js";
import { ApiError, isUniqueViolation } from "../errors.js";
import { runIdempotent } from "../idempotency.js";
import { assertEnvironmentQuota } from "../quota.js";
import type { Db } from "../db/client.js";
import { auditLogs, environments } from "../db/schema.js";
import { resolvePreviewParent } from "./github.js";
import { idempotencyKeyHeader } from "./headers.js";
import type { EnvironmentQueue } from "../queue.js";

export const projectParams = z.object({ projectId: z.string().uuid() });
export const environmentParams = projectParams.extend({ environmentId: z.string().uuid() });

// Minutes, not hours: a CI job that needs longer than this is better served by a real preview
// environment (roadmap.md Phase 4), which doesn't carry a hard TTL.
const MIN_CI_TTL_SECONDS = 60;
const MAX_CI_TTL_SECONDS = 4 * 60 * 60;

export const createCiEnvironmentBody = z.object({
  // Optional: a CI job usually has no stable name to give it, so one is generated when omitted.
  name: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "use lowercase letters, numbers and hyphens")
    .optional(),
  ttlSeconds: z.number().int().min(MIN_CI_TTL_SECONDS).max(MAX_CI_TTL_SECONDS),
});

function randomEnvName(): string {
  return `ci-${randomBytes(4).toString("hex")}`;
}

export const environmentRoutes: FastifyPluginAsync<{ db: Db; environmentQueue?: EnvironmentQueue }> = async (
  app,
  { db, environmentQueue },
) => {
  app.get(
    "/projects/:projectId/environments",
    {
      config: {
        openapi: {
          operationId: "listEnvironments",
          tags: ["Environments"],
          summary: "Lists the project's environments",
          pathSchema: projectParams,
          success: { status: 200, description: "Environments", schema: listOf(EnvironmentSchema) },
          errors: [404],
        },
      },
    },
    async (request) => {
    const { projectId } = projectParams.parse(request.params);
    await requireProjectAccess(db, request.auth!.userId, projectId);

    const data = await db
      .select()
      .from(environments)
      .where(and(eq(environments.projectId, projectId), isNull(environments.deletedAt)))
      .orderBy(asc(environments.createdAt), asc(environments.id));

    return { data };
  });

  // Ephemeral environment for a CI job (roadmap.md Phase 5), distinct from a PR preview: created
  // directly through the API (no GitHub webhook involved) and torn down by TTL instead of a PR's
  // lifecycle. Inherits variables from the same Staging/Production fallback a preview uses
  // (resolvePreviewParent) -- the actual copy happens once a service instance is created in it,
  // the same as for a preview (api/src/routes/github.ts's copyInstanceVariables); creating the
  // environment itself carries no service yet.
  app.post(
    "/projects/:projectId/environments/ci",
    {
      config: {
        openapi: {
          operationId: "createCiEnvironment",
          tags: ["Environments"],
          summary: "Creates an ephemeral environment for a CI job, torn down automatically after ttlSeconds",
          pathSchema: projectParams,
          bodySchema: createCiEnvironmentBody,
          idempotent: true,
          success: { status: 201, description: "Environment created", schema: EnvironmentSchema },
          errors: [403, 404, 409],
        },
      },
    },
    async (request, reply) => {
      const { projectId } = projectParams.parse(request.params);
      const body = createCiEnvironmentBody.parse(request.body);
      const userId = request.auth!.userId;
      const { organizationId } = await requireProjectAccess(db, userId, projectId, { write: true });

      const result = await runIdempotent(db, {
        userId,
        key: idempotencyKeyHeader(request.headers),
        // Hashed from the original body, not a resolved name: generating the random name here
        // (outside `run`) would make the same Idempotency-Key hash differently on every retry,
        // since each call would get its own random name before the cache lookup even happens.
        payload: { projectId, ...body },
        run: async (tx) => {
          await assertEnvironmentQuota(tx, projectId);
          const parent = await resolvePreviewParent(tx, projectId);
          const name = body.name ?? randomEnvName();

          let created;
          try {
            [created] = await tx
              .insert(environments)
              .values({
                projectId,
                name,
                type: "ci",
                parentEnvironmentId: parent?.id ?? null,
                ttlAt: new Date(Date.now() + body.ttlSeconds * 1000),
              })
              .returning();
          } catch (err) {
            if (isUniqueViolation(err, "environments_project_name_idx")) {
              throw new ApiError(409, "name_taken", `Environment name "${name}" is already in use in this project.`);
            }
            throw err;
          }

          await tx.insert(auditLogs).values({
            organizationId,
            actorId: userId,
            action: "environment.create_ci",
            target: `environment:${created.id}`,
            metadata: { name: created.name, ttlSeconds: body.ttlSeconds },
          });
          return { status: 201, body: created };
        },
      });

      return reply.code(result.status).send(result.body);
    },
  );

  // Explicit early teardown (the CI job finished before its TTL), rather than waiting for the
  // periodic sweep (workers/src/decommission) to notice. Scoped to type "ci" on purpose: this
  // route isn't a general "delete any environment" API, which was never asked for and would need
  // its own review (production/staging environments have no teardown path at all today).
  app.delete(
    "/projects/:projectId/environments/:environmentId",
    {
      config: {
        openapi: {
          operationId: "deleteCiEnvironment",
          tags: ["Environments"],
          summary: "Tears down an ephemeral CI environment immediately, instead of waiting for its TTL",
          pathSchema: environmentParams,
          success: { status: 204, description: "Environment scheduled for teardown" },
          errors: [403, 404],
        },
      },
    },
    async (request, reply) => {
      const { projectId, environmentId } = environmentParams.parse(request.params);
      const userId = request.auth!.userId;
      const { organizationId } = await requireProjectAccess(db, userId, projectId, { write: true });

      const [env] = await db
        .select({ id: environments.id, type: environments.type })
        .from(environments)
        .where(and(eq(environments.id, environmentId), eq(environments.projectId, projectId), isNull(environments.deletedAt)));
      if (!env) throw new ApiError(404, "environment_not_found", "Environment not found.");
      if (env.type !== "ci") {
        throw new ApiError(403, "forbidden", 'Only an ephemeral "ci" environment can be torn down directly.');
      }

      // Due now rather than at some future TTL: the sweep (workers/src/decommission) picks up
      // anything with ttl_at in the past on its next tick either way, so this is a correct
      // fallback even if the immediate enqueue below never reaches the queue.
      await db.update(environments).set({ ttlAt: new Date(), updatedAt: new Date() }).where(eq(environments.id, env.id));
      await db.insert(auditLogs).values({
        organizationId,
        actorId: userId,
        action: "environment.delete_ci",
        target: `environment:${env.id}`,
      });

      if (environmentQueue) {
        try {
          await environmentQueue.enqueueDecommission({ environmentId: env.id });
        } catch {
          // Best effort: the sweep's next tick (at most a few minutes away) still catches it via ttl_at.
        }
      }

      return reply.code(204).send();
    },
  );
};
