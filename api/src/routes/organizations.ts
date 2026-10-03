import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { AuditLogSchema, OrganizationSchema, OrganizationSummarySchema, listOf, paginated } from "../openapi/schemas.js";
import { requireMembership } from "../access.js";
import { ApiError } from "../errors.js";
import { runIdempotent } from "../idempotency.js";
import { createdAtMs, decodeCursor, encodeCursor } from "../pagination.js";
import { slugify } from "../slug.js";
import type { Db } from "../db/client.js";
import { auditLogs, memberships, organizations } from "../db/schema.js";
import { idempotencyKeyHeader } from "./headers.js";

const organizationParams = z.object({ organizationId: z.string().uuid() });

const listAuditLogsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

// `id` is a bigint identity column; drizzle returns it as a JS BigInt, which neither JSON.stringify
// nor the cursor (a JSON-encoded string) can carry directly, so it's converted to a decimal string.
function toAuditLogResponse(row: typeof auditLogs.$inferSelect) {
  return {
    id: row.id.toString(),
    actorId: row.actorId,
    action: row.action,
    target: row.target,
    metadata: row.metadata,
    createdAt: row.occurredAt,
  };
}

export const createOrganizationBody = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .max(60)
    .optional(),
});

export const organizationRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.post(
    "/organizations",
    {
      config: {
        openapi: {
          operationId: "createOrganization",
          tags: ["Organizations"],
          summary: "Creates an organization; the creator becomes its owner",
          bodySchema: createOrganizationBody,
          idempotent: true,
          success: { status: 201, description: "Organization created", schema: OrganizationSchema },
          errors: [409],
        },
      },
    },
    async (request, reply) => {
    const body = createOrganizationBody.parse(request.body);
    const userId = request.auth!.userId;
    const slug = body.slug ?? slugify(body.name);

    const result = await runIdempotent(db, {
      userId,
      key: idempotencyKeyHeader(request.headers),
      payload: { ...body, slug },
      run: async (tx) => {
        const [taken] = await tx
          .select({ id: organizations.id })
          .from(organizations)
          .where(and(eq(organizations.slug, slug), isNull(organizations.deletedAt)))
          .limit(1);
        if (taken) throw new ApiError(409, "slug_taken", `Slug "${slug}" is already in use.`);

        const [org] = await tx
          .insert(organizations)
          .values({ name: body.name, slug })
          .returning();
        await tx.insert(memberships).values({ organizationId: org.id, userId, role: "owner" });
        await tx.insert(auditLogs).values({
          organizationId: org.id,
          actorId: userId,
          action: "organization.create",
          target: `organization:${org.id}`,
        });
        return { status: 201, body: org };
      },
    });

    return reply.code(result.status).send(result.body);
  });

  app.get(
    "/organizations",
    {
      config: {
        openapi: {
          operationId: "listOrganizations",
          tags: ["Organizations"],
          summary: "Lists the authenticated user's organizations",
          success: { status: 200, description: "Organizations", schema: listOf(OrganizationSummarySchema) },
        },
      },
    },
    async (request) => {
    const rows = await db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        role: memberships.role,
        createdAt: organizations.createdAt,
      })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
      .where(and(eq(memberships.userId, request.auth!.userId), isNull(organizations.deletedAt)))
      .orderBy(desc(organizations.createdAt));

    return { data: rows };
  });

  app.get(
    "/organizations/:organizationId/audit-logs",
    {
      config: {
        openapi: {
          operationId: "listAuditLogs",
          tags: ["Organizations"],
          summary: "Lists an organization's audit log, from most recent to oldest",
          pathSchema: organizationParams,
          querySchema: listAuditLogsQuery,
          success: { status: 200, description: "Audit log entries", schema: paginated(AuditLogSchema) },
          errors: [404],
        },
      },
    },
    async (request) => {
      const { organizationId } = organizationParams.parse(request.params);
      const query = listAuditLogsQuery.parse(request.query);
      // Any role can read the audit log; a missing organization and a non-member get the same 404
      // (requireMembership doesn't distinguish them either, so existence isn't revealed).
      await requireMembership(db, request.auth!.userId, organizationId);

      const cursor = decodeCursor(query.cursor);
      const ts = createdAtMs(auditLogs.occurredAt);

      const rows = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.organizationId, organizationId),
            cursor
              ? or(
                  sql`${ts} < ${cursor.t}`,
                  and(sql`${ts} = ${cursor.t}`, sql`${auditLogs.id} < ${cursor.id}::bigint`),
                )
              : undefined,
          ),
        )
        .orderBy(desc(ts), desc(auditLogs.id))
        .limit(query.limit + 1);

      const hasMore = rows.length > query.limit;
      const data = hasMore ? rows.slice(0, query.limit) : rows;
      const last = data.at(-1);
      const nextCursor = hasMore && last ? encodeCursor({ t: last.occurredAt.toISOString(), id: last.id.toString() }) : null;

      return { data: data.map(toAuditLogResponse), nextCursor };
    },
  );
};
