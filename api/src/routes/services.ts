import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { ServiceWithInstancesSchema, ServiceListItemSchema, listOf } from "../openapi/schemas.js";
import { requireProjectAccess } from "../access.js";
import { ApiError } from "../errors.js";
import { runIdempotent } from "../idempotency.js";
import { assertServiceQuota } from "../quota.js";
import type { Db } from "../db/client.js";
import { auditLogs, environments, serviceInstances, services } from "../db/schema.js";
import { idempotencyKeyHeader } from "./headers.js";

export const projectParams = z.object({ projectId: z.string().uuid() });

export const createServiceBody = z
  .object({
    name: z
      .string()
      .min(1)
      .max(63)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "use lowercase letters, numbers and hyphens"),
    kind: z.enum(["web", "worker", "postgres", "redis"]),
    source: z.enum(["github_repo", "image", "template", "postgres_template", "redis_template"]),
    rootDir: z
      .string()
      .startsWith("/")
      .max(255)
      .refine((p) => !p.split("/").includes(".."), "rootDir cannot contain ..")
      .default("/"),
    // Clone URL, only for github_repo. http(s) only: the build runs in the cluster and doesn't accept other protocols.
    repoUrl: z
      .string()
      .max(500)
      .regex(/^https?:\/\/\S+$/, "use an http(s) URL")
      .optional(),
  })
  .superRefine((body, ctx) => {
    if (body.source === "github_repo" && !body.repoUrl) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["repoUrl"], message: "repoUrl is required for github_repo" });
    }
    if (body.source !== "github_repo" && body.repoUrl) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["repoUrl"], message: "repoUrl only exists for github_repo" });
    }
  });

export const serviceRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  // Creates the service and one instance in each of the project's environments, in the same transaction.
  app.post(
    "/projects/:projectId/services",
    {
      config: {
        openapi: {
          operationId: "createService",
          tags: ["Services"],
          summary: "Creates a service and one instance in each of the project's environments",
          pathSchema: projectParams,
          bodySchema: createServiceBody,
          idempotent: true,
          success: { status: 201, description: "Service created", schema: ServiceWithInstancesSchema },
          errors: [403, 404, 409],
        },
      },
    },
    async (request, reply) => {
    const { projectId } = projectParams.parse(request.params);
    const body = createServiceBody.parse(request.body);
    const userId = request.auth!.userId;
    const { organizationId } = await requireProjectAccess(db, userId, projectId, { write: true });

    const result = await runIdempotent(db, {
      userId,
      key: idempotencyKeyHeader(request.headers),
      payload: { projectId, ...body },
      run: async (tx) => {
        await assertServiceQuota(tx, projectId);

        const [taken] = await tx
          .select({ id: services.id })
          .from(services)
          .where(and(eq(services.projectId, projectId), eq(services.name, body.name), isNull(services.deletedAt)))
          .limit(1);
        if (taken) throw new ApiError(409, "name_taken", `A service named "${body.name}" already exists.`);

        const [service] = await tx.insert(services).values({ projectId, ...body }).returning();

        const envs = await tx
          .select({ id: environments.id })
          .from(environments)
          .where(and(eq(environments.projectId, projectId), isNull(environments.deletedAt)));
        const instances = envs.length
          ? await tx
              .insert(serviceInstances)
              .values(envs.map((e) => ({ serviceId: service.id, environmentId: e.id })))
              .returning()
          : [];

        await tx.insert(auditLogs).values({
          organizationId,
          actorId: userId,
          action: "service.create",
          target: `service:${service.id}`,
        });
        return { status: 201, body: { ...service, instances } };
      },
    });

    return reply.code(result.status).send(result.body);
  });

  app.get(
    "/projects/:projectId/services",
    {
      config: {
        openapi: {
          operationId: "listServices",
          tags: ["Services"],
          summary: "Lists the project's services with their instances per environment",
          pathSchema: projectParams,
          success: { status: 200, description: "Services", schema: listOf(ServiceListItemSchema) },
          errors: [404],
        },
      },
    },
    async (request) => {
    const { projectId } = projectParams.parse(request.params);
    await requireProjectAccess(db, request.auth!.userId, projectId);

    const rows = await db
      .select({
        service: services,
        instance: serviceInstances,
        environmentName: environments.name,
      })
      .from(services)
      .leftJoin(serviceInstances, and(eq(serviceInstances.serviceId, services.id), isNull(serviceInstances.deletedAt)))
      .leftJoin(environments, eq(environments.id, serviceInstances.environmentId))
      .where(and(eq(services.projectId, projectId), isNull(services.deletedAt)))
      .orderBy(asc(services.createdAt), asc(services.id));

    // Groups the join rows (one per instance) into a service with its list of instances.
    const byService = new Map<string, { service: typeof services.$inferSelect; instances: unknown[] }>();
    for (const row of rows) {
      const entry = byService.get(row.service.id) ?? { service: row.service, instances: [] };
      if (row.instance) {
        entry.instances.push({
          id: row.instance.id,
          environmentId: row.instance.environmentId,
          environmentName: row.environmentName,
          replicas: row.instance.replicas,
        });
      }
      byService.set(row.service.id, entry);
    }

    return {
      data: [...byService.values()].map(({ service, instances }) => ({ ...service, instances })),
    };
  });
};
