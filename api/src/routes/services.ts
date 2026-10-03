import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { requireProjectAccess } from "../access.js";
import { ApiError } from "../errors.js";
import { runIdempotent } from "../idempotency.js";
import type { Db } from "../db/client.js";
import { auditLogs, environments, serviceInstances, services } from "../db/schema.js";
import { idempotencyKeyHeader } from "./headers.js";

const projectParams = z.object({ projectId: z.string().uuid() });

const createServiceBody = z.object({
  name: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "use letras minúsculas, números e hífens"),
  kind: z.enum(["web", "worker", "postgres", "redis"]),
  source: z.enum(["github_repo", "image", "template"]),
  rootDir: z
    .string()
    .startsWith("/")
    .max(255)
    .default("/"),
});

export const serviceRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  // Cria o serviço e uma instância em cada ambiente do projeto, na mesma transação.
  app.post("/projects/:projectId/services", async (request, reply) => {
    const { projectId } = projectParams.parse(request.params);
    const body = createServiceBody.parse(request.body);
    const userId = request.auth!.userId;
    const { organizationId } = await requireProjectAccess(db, userId, projectId, { write: true });

    const result = await runIdempotent(db, {
      userId,
      key: idempotencyKeyHeader(request.headers),
      payload: { projectId, ...body },
      run: async (tx) => {
        const [taken] = await tx
          .select({ id: services.id })
          .from(services)
          .where(and(eq(services.projectId, projectId), eq(services.name, body.name), isNull(services.deletedAt)))
          .limit(1);
        if (taken) throw new ApiError(409, "name_taken", `Já existe um serviço chamado "${body.name}".`);

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

  app.get("/projects/:projectId/services", async (request) => {
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

    // Agrupa as linhas do join (uma por instância) em um serviço com a lista de instâncias.
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
