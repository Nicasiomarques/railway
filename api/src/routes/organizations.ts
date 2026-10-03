import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { OrganizationSchema, OrganizationSummarySchema, listOf } from "../openapi/schemas.js";
import { ApiError } from "../errors.js";
import { runIdempotent } from "../idempotency.js";
import { slugify } from "../slug.js";
import type { Db } from "../db/client.js";
import { auditLogs, memberships, organizations } from "../db/schema.js";
import { idempotencyKeyHeader } from "./headers.js";

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
};
