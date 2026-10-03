import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { ConnectionSchema, ConnectionListItemSchema, listOf } from "../openapi/schemas.js";
import { requireProjectAccess } from "../access.js";
import { ApiError } from "../errors.js";
import type { Db } from "../db/client.js";
import { auditLogs, connections, environments, serviceInstances, services } from "../db/schema.js";

export const projectParams = z.object({ projectId: z.string().uuid() });

export const createConnectionBody = z.object({
  fromInstanceId: z.string().uuid(),
  toInstanceId: z.string().uuid(),
});

export const deleteConnectionQuery = z.object({
  fromInstanceId: z.string().uuid(),
  toInstanceId: z.string().uuid(),
});

// Conexões são internas ao ambiente (architecture.md §8): as duas pontas precisam
// pertencer ao projeto e ao mesmo ambiente.
export const connectionRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.post(
    "/projects/:projectId/connections",
    {
      config: {
        openapi: {
          operationId: "createConnection",
          tags: ["Conexões"],
          summary: "Conecta duas instâncias do mesmo ambiente",
          pathSchema: projectParams,
          bodySchema: createConnectionBody,
          success: { status: 201, description: "Conexão criada", schema: ConnectionSchema },
          errors: [403, 404],
        },
      },
    },
    async (request, reply) => {
    const { projectId } = projectParams.parse(request.params);
    const body = createConnectionBody.parse(request.body);
    const userId = request.auth!.userId;
    const { organizationId } = await requireProjectAccess(db, userId, projectId, { write: true });

    if (body.fromInstanceId === body.toInstanceId) {
      throw new ApiError(400, "invalid_connection", "Um serviço não pode se conectar a si mesmo.");
    }

    const found = await db
      .select({
        instanceId: serviceInstances.id,
        environmentId: serviceInstances.environmentId,
        environmentName: environments.name,
        projectId: services.projectId,
      })
      .from(serviceInstances)
      .innerJoin(services, eq(services.id, serviceInstances.serviceId))
      .innerJoin(environments, eq(environments.id, serviceInstances.environmentId))
      .where(
        and(
          inArray(serviceInstances.id, [body.fromInstanceId, body.toInstanceId]),
          isNull(serviceInstances.deletedAt),
          isNull(services.deletedAt),
        ),
      );

    const from = found.find((r) => r.instanceId === body.fromInstanceId);
    const to = found.find((r) => r.instanceId === body.toInstanceId);
    if (!from || !to || from.projectId !== projectId || to.projectId !== projectId) {
      throw new ApiError(404, "instance_not_found", "Instância não encontrada neste projeto.");
    }
    if (from.environmentId !== to.environmentId) {
      throw new ApiError(400, "invalid_connection", "As instâncias precisam estar no mesmo ambiente.");
    }

    const [row] = await db
      .insert(connections)
      .values({ fromInstanceId: body.fromInstanceId, toInstanceId: body.toInstanceId })
      .onConflictDoNothing()
      .returning();

    if (row) {
      await db.insert(auditLogs).values({
        organizationId,
        actorId: userId,
        action: "connection.create",
        target: `connection:${body.fromInstanceId}->${body.toInstanceId}`,
      });
    }

    return reply.code(201).send({
      fromInstanceId: body.fromInstanceId,
      toInstanceId: body.toInstanceId,
      environmentName: from.environmentName,
    });
  });

  app.get(
    "/projects/:projectId/connections",
    {
      config: {
        openapi: {
          operationId: "listConnections",
          tags: ["Conexões"],
          summary: "Lista as conexões do projeto",
          pathSchema: projectParams,
          success: { status: 200, description: "Conexões", schema: listOf(ConnectionListItemSchema) },
          errors: [404],
        },
      },
    },
    async (request) => {
    const { projectId } = projectParams.parse(request.params);
    await requireProjectAccess(db, request.auth!.userId, projectId);

    const rows = await db
      .select({
        fromInstanceId: connections.fromInstanceId,
        toInstanceId: connections.toInstanceId,
        environmentName: environments.name,
        createdAt: connections.createdAt,
      })
      .from(connections)
      .innerJoin(serviceInstances, eq(serviceInstances.id, connections.fromInstanceId))
      .innerJoin(services, eq(services.id, serviceInstances.serviceId))
      .innerJoin(environments, eq(environments.id, serviceInstances.environmentId))
      .where(and(eq(services.projectId, projectId), isNull(services.deletedAt)))
      .orderBy(asc(connections.createdAt));

    return { data: rows };
  });

  app.delete(
    "/projects/:projectId/connections",
    {
      config: {
        openapi: {
          operationId: "deleteConnection",
          tags: ["Conexões"],
          summary: "Remove uma conexão entre duas instâncias",
          pathSchema: projectParams,
          querySchema: deleteConnectionQuery,
          success: { status: 204, description: "Conexão removida" },
          errors: [403, 404],
        },
      },
    },
    async (request, reply) => {
    const { projectId } = projectParams.parse(request.params);
    const query = deleteConnectionQuery.parse(request.query);
    const userId = request.auth!.userId;
    const { organizationId } = await requireProjectAccess(db, userId, projectId, { write: true });

    const [deleted] = await db
      .delete(connections)
      .where(
        and(
          eq(connections.fromInstanceId, query.fromInstanceId),
          eq(connections.toInstanceId, query.toInstanceId),
          // A conexão precisa pertencer a este projeto, mesmo que o id venha de outro.
          inArray(
            connections.fromInstanceId,
            db
              .select({ id: serviceInstances.id })
              .from(serviceInstances)
              .innerJoin(services, eq(services.id, serviceInstances.serviceId))
              .where(eq(services.projectId, projectId)),
          ),
        ),
      )
      .returning();

    if (!deleted) throw new ApiError(404, "connection_not_found", "Conexão não encontrada.");

    await db.insert(auditLogs).values({
      organizationId,
      actorId: userId,
      action: "connection.delete",
      target: `connection:${query.fromInstanceId}->${query.toInstanceId}`,
    });
    return reply.code(204).send();
  });
};
