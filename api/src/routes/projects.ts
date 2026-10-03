import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { ProjectSchema, paginated } from "../openapi/schemas.js";
import { requireMembership } from "../access.js";
import { ApiError } from "../errors.js";
import { runIdempotent } from "../idempotency.js";
import { createdAtMs, decodeCursor, encodeCursor } from "../pagination.js";
import { slugify } from "../slug.js";
import type { Db } from "../db/client.js";
import { auditLogs, environments, projects } from "../db/schema.js";
import { idempotencyKeyHeader } from "./headers.js";

export const createProjectBody = z.object({
  organizationId: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .max(60)
    .optional(),
});

export const listProjectsQuery = z.object({
  organizationId: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

export const projectRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.post(
    "/projects",
    {
      config: {
        openapi: {
          operationId: "createProject",
          tags: ["Projetos"],
          summary: "Cria um projeto com o ambiente production",
          bodySchema: createProjectBody,
          idempotent: true,
          success: { status: 201, description: "Projeto criado", schema: ProjectSchema },
          errors: [403, 404, 409],
        },
      },
    },
    async (request, reply) => {
    const body = createProjectBody.parse(request.body);
    const userId = request.auth!.userId;
    const slug = body.slug ?? slugify(body.name);

    const role = await requireMembership(db, userId, body.organizationId);
    if (role === "viewer") {
      throw new ApiError(403, "forbidden", "Papel 'viewer' não pode criar projetos.");
    }

    const result = await runIdempotent(db, {
      userId,
      key: idempotencyKeyHeader(request.headers),
      payload: { ...body, slug },
      run: async (tx) => {
        const [taken] = await tx
          .select({ id: projects.id })
          .from(projects)
          .where(
            and(
              eq(projects.organizationId, body.organizationId),
              eq(projects.slug, slug),
              isNull(projects.deletedAt),
            ),
          )
          .limit(1);
        if (taken) throw new ApiError(409, "slug_taken", `Slug "${slug}" já está em uso nesta organização.`);

        const [project] = await tx
          .insert(projects)
          .values({ organizationId: body.organizationId, name: body.name, slug })
          .returning();
        // Todo projeto nasce com o ambiente de produção (ver architecture.md §6).
        await tx.insert(environments).values({ projectId: project.id, name: "production", type: "production" });
        await tx.insert(auditLogs).values({
          organizationId: body.organizationId,
          actorId: userId,
          action: "project.create",
          target: `project:${project.id}`,
        });
        return { status: 201, body: project };
      },
    });

    return reply.code(result.status).send(result.body);
  });

  app.get(
    "/projects",
    {
      config: {
        openapi: {
          operationId: "listProjects",
          tags: ["Projetos"],
          summary: "Lista os projetos de uma organização, paginados por cursor",
          querySchema: listProjectsQuery,
          success: { status: 200, description: "Projetos", schema: paginated(ProjectSchema) },
          errors: [404],
        },
      },
    },
    async (request) => {
    const query = listProjectsQuery.parse(request.query);
    await requireMembership(db, request.auth!.userId, query.organizationId);

    const cursor = decodeCursor(query.cursor);
    const ts = createdAtMs(projects.createdAt);

    const rows = await db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.organizationId, query.organizationId),
          isNull(projects.deletedAt),
          cursor
            ? or(
                sql`${ts} < ${cursor.t}`,
                and(sql`${ts} = ${cursor.t}`, sql`${projects.id} < ${cursor.id}`),
              )
            : undefined,
        ),
      )
      .orderBy(desc(ts), desc(projects.id))
      .limit(query.limit + 1);

    const hasMore = rows.length > query.limit;
    const data = hasMore ? rows.slice(0, query.limit) : rows;
    const last = data.at(-1);
    // Date do pg tem precisão de ms, igual ao date_trunc usado na ordenação.
    const nextCursor = hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null;

    return { data, nextCursor };
  });
};
