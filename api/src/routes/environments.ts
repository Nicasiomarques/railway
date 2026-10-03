import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { EnvironmentSchema, listOf } from "../openapi/schemas.js";
import { requireProjectAccess } from "../access.js";
import type { Db } from "../db/client.js";
import { environments } from "../db/schema.js";

export const projectParams = z.object({ projectId: z.string().uuid() });

export const environmentRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
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
};
