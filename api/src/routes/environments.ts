import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { requireProjectAccess } from "../access.js";
import type { Db } from "../db/client.js";
import { environments } from "../db/schema.js";

const projectParams = z.object({ projectId: z.string().uuid() });

export const environmentRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.get("/projects/:projectId/environments", async (request) => {
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
