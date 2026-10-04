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

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

type NewServiceFields = {
  name: string;
  kind: "web" | "worker" | "postgres" | "redis" | "cron" | "object_storage";
  source: "github_repo" | "image" | "template" | "postgres_template" | "redis_template" | "minio_template";
  rootDir?: string;
  repoUrl?: string;
  schedule?: string;
};

// Shared by `POST /projects/:projectId/services` and the template-marketplace deploy route
// (routes/templates.ts): quota check, name-uniqueness check, insert the service row, insert one
// instance per existing environment, and an audit log entry - all inside the caller's transaction.
export async function createServiceAndInstances(
  tx: Tx,
  { organizationId, userId, projectId, service }: { organizationId: string; userId: string; projectId: string; service: NewServiceFields },
): Promise<{ status: 201; body: Record<string, unknown> }> {
  await assertServiceQuota(tx, projectId);

  const [taken] = await tx
    .select({ id: services.id })
    .from(services)
    .where(and(eq(services.projectId, projectId), eq(services.name, service.name), isNull(services.deletedAt)))
    .limit(1);
  if (taken) throw new ApiError(409, "name_taken", `A service named "${service.name}" already exists.`);

  const { schedule, ...serviceBody } = service;
  const [created] = await tx.insert(services).values({ projectId, rootDir: "/", ...serviceBody }).returning();

  const envs = await tx
    .select({ id: environments.id })
    .from(environments)
    .where(and(eq(environments.projectId, projectId), isNull(environments.deletedAt)));
  const instances = envs.length
    ? await tx
        .insert(serviceInstances)
        .values(envs.map((e) => ({ serviceId: created.id, environmentId: e.id, schedule: schedule ?? null })))
        .returning()
    : [];

  await tx.insert(auditLogs).values({
    organizationId,
    actorId: userId,
    action: "service.create",
    target: `service:${created.id}`,
  });
  return { status: 201, body: { ...created, instances } };
}

export const projectParams = z.object({ projectId: z.string().uuid() });

export const createServiceBody = z
  .object({
    name: z
      .string()
      .min(1)
      .max(63)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "use lowercase letters, numbers and hyphens"),
    kind: z.enum(["web", "worker", "postgres", "redis", "cron", "object_storage"]),
    source: z.enum(["github_repo", "image", "template", "postgres_template", "redis_template", "minio_template"]),
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
    // Only for kind "cron": a 5-field cron expression (minute hour day-of-month month day-of-week).
    // Basic shape check only (each field is `*`, a number, or a comma/range/step expression made of
    // digits, `*`, `-`, `/` and `,`) -- not a full parser, matching the task's "simple regex" ask.
    schedule: z
      .string()
      .max(100)
      .regex(/^(\*|[0-9*/,-]+)(\s+(\*|[0-9*/,-]+)){4}$/, "use a 5-field cron expression, e.g. \"0 3 * * *\"")
      .optional(),
  })
  .superRefine((body, ctx) => {
    if (body.source === "github_repo" && !body.repoUrl) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["repoUrl"], message: "repoUrl is required for github_repo" });
    }
    if (body.source !== "github_repo" && body.repoUrl) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["repoUrl"], message: "repoUrl only exists for github_repo" });
    }
    if (body.kind === "cron" && !body.schedule) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["schedule"], message: "schedule is required for kind cron" });
    }
    if (body.kind !== "cron" && body.schedule) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["schedule"], message: "schedule only exists for kind cron" });
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
      run: (tx) => createServiceAndInstances(tx, { organizationId, userId, projectId, service: body }),
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
          schedule: row.instance.schedule,
        });
      }
      byService.set(row.service.id, entry);
    }

    return {
      data: [...byService.values()].map(({ service, instances }) => ({ ...service, instances })),
    };
  });
};
