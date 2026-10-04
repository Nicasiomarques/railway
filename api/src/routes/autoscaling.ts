import type { FastifyPluginAsync } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { AutoscalingPolicySchema } from "../openapi/schemas.js";
import { requireInstanceAccess } from "../access.js";
import { ApiError } from "../errors.js";
import type { Db } from "../db/client.js";
import { auditLogs, serviceInstances } from "../db/schema.js";

export const instanceParams = z.object({ instanceId: z.string().uuid() });

// Mirrors AutoscalingPolicy in workers/src/runtime/adapter.ts: minReplicas/maxReplicas/
// targetCpuPercent/cpuRequestMillicores are required together, only when enabling.
const putAutoscalingBody = z
  .object({
    enabled: z.boolean(),
    // When enabled is false, this is the instance's new fixed replica count (what runs today,
    // just with no endpoint to set it); when true, it's ignored in favor of minReplicas.
    replicas: z.number().int().min(1).max(50).optional(),
    minReplicas: z.number().int().min(1).max(50).optional(),
    maxReplicas: z.number().int().min(1).max(50).optional(),
    targetCpuPercent: z.number().int().min(1).max(100).optional(),
    cpuRequestMillicores: z.number().int().min(10).max(16000).optional(),
  })
  .superRefine((body, ctx) => {
    if (!body.enabled) return;
    for (const field of ["minReplicas", "maxReplicas", "targetCpuPercent", "cpuRequestMillicores"] as const) {
      if (body[field] === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} is required when enabled is true` });
      }
    }
    if (body.minReplicas !== undefined && body.maxReplicas !== undefined && body.minReplicas > body.maxReplicas) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["maxReplicas"], message: "maxReplicas must be >= minReplicas" });
    }
  });

function toResponse(row: typeof serviceInstances.$inferSelect) {
  return {
    instanceId: row.id,
    enabled: row.autoscalingEnabled,
    replicas: row.replicas,
    minReplicas: row.minReplicas,
    maxReplicas: row.maxReplicas,
    targetCpuPercent: row.targetCpuPercent,
    cpuRequestMillicores: row.cpuRequestMillicores,
  };
}

export const autoscalingRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.get(
    "/services/:instanceId/autoscaling",
    {
      config: {
        openapi: {
          operationId: "getAutoscaling",
          tags: ["Services"],
          summary: "Gets the instance's autoscaling policy (or its fixed replica count, when disabled)",
          pathSchema: instanceParams,
          success: { status: 200, description: "Autoscaling policy", schema: AutoscalingPolicySchema },
          errors: [404],
        },
      },
    },
    async (request) => {
      const { instanceId } = instanceParams.parse(request.params);
      await requireInstanceAccess(db, request.auth!.userId, instanceId);

      const [row] = await db
        .select()
        .from(serviceInstances)
        .where(and(eq(serviceInstances.id, instanceId), isNull(serviceInstances.deletedAt)));
      if (!row) throw new ApiError(404, "instance_not_found", "Service instance not found.");
      return toResponse(row);
    },
  );

  app.put(
    "/services/:instanceId/autoscaling",
    {
      config: {
        openapi: {
          operationId: "putAutoscaling",
          tags: ["Services"],
          summary: "Enables or disables autoscaling for the instance; the next deploy applies it",
          pathSchema: instanceParams,
          bodySchema: putAutoscalingBody,
          success: { status: 200, description: "Autoscaling policy", schema: AutoscalingPolicySchema },
          errors: [403, 404],
        },
      },
    },
    async (request) => {
      const { instanceId } = instanceParams.parse(request.params);
      const body = putAutoscalingBody.parse(request.body);
      const userId = request.auth!.userId;
      const { organizationId } = await requireInstanceAccess(db, userId, instanceId, { write: true });

      const [updated] = await db
        .update(serviceInstances)
        .set(
          body.enabled
            ? {
                autoscalingEnabled: true,
                minReplicas: body.minReplicas,
                maxReplicas: body.maxReplicas,
                targetCpuPercent: body.targetCpuPercent,
                cpuRequestMillicores: body.cpuRequestMillicores,
                updatedAt: new Date(),
              }
            : {
                autoscalingEnabled: false,
                minReplicas: null,
                maxReplicas: null,
                targetCpuPercent: null,
                cpuRequestMillicores: null,
                ...(body.replicas !== undefined ? { replicas: body.replicas } : {}),
                updatedAt: new Date(),
              },
        )
        .where(eq(serviceInstances.id, instanceId))
        .returning();

      await db.insert(auditLogs).values({
        organizationId,
        actorId: userId,
        action: "instance.autoscaling.update",
        target: `service_instance:${instanceId}`,
        metadata: toResponse(updated),
      });

      return toResponse(updated);
    },
  );
};
