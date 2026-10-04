import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { ExtensionSchema, listOf } from "../openapi/schemas.js";
import { requireMembership } from "../access.js";
import { ApiError } from "../errors.js";
import type { Db } from "../db/client.js";
import { auditLogs, projects, webhookSubscriptions } from "../db/schema.js";

// An extension (roadmap.md Phase 5 "extensions") is a webhook subscription with a manifest - a
// name and description - attached. It's delivered through the exact same worker
// (workers/src/webhooks) as a plain subscription created via routes/webhooks.ts; the two are
// otherwise indistinguishable in the table, so every query here filters on `name` being set.

export const organizationParams = z.object({ organizationId: z.string().uuid() });
export const extensionParams = organizationParams.extend({ extensionId: z.string().uuid() });

const eventType = z
  .string()
  .regex(/^[a-z]+(\.[a-z0-9_]+)+$/, 'use the form "resource.event", e.g. "deployment.status_changed"');

export const installExtensionBody = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  // Omitted or null: the extension applies to every project in the organization.
  projectId: z.string().uuid().nullable().optional(),
  url: z.string().url().max(2048),
  secret: z.string().min(16).max(200),
  events: z.array(eventType).min(1).max(50),
  isActive: z.boolean().default(true),
});

// Never includes `secret`: same as routes/webhooks.ts's toResponse.
function toResponse(row: typeof webhookSubscriptions.$inferSelect) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    name: row.name,
    description: row.description,
    url: row.url,
    events: row.events,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function requireWriteMembership(db: Db, userId: string, organizationId: string): Promise<void> {
  const role = await requireMembership(db, userId, organizationId);
  if (role === "viewer") throw new ApiError(403, "forbidden", "The 'viewer' role cannot modify extensions.");
}

export const extensionRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.post(
    "/organizations/:organizationId/extensions",
    {
      config: {
        openapi: {
          operationId: "installExtension",
          tags: ["Extensions"],
          summary: "Installs an extension: a named, described webhook subscription",
          pathSchema: organizationParams,
          bodySchema: installExtensionBody,
          success: { status: 201, description: "Extension installed", schema: ExtensionSchema },
          errors: [403, 404],
        },
      },
    },
    async (request, reply) => {
      const { organizationId } = organizationParams.parse(request.params);
      const body = installExtensionBody.parse(request.body);
      const userId = request.auth!.userId;
      await requireWriteMembership(db, userId, organizationId);

      if (body.projectId) {
        const [project] = await db
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.id, body.projectId), eq(projects.organizationId, organizationId)));
        if (!project) throw new ApiError(404, "project_not_found", "Project not found.");
      }

      const [created] = await db
        .insert(webhookSubscriptions)
        .values({
          organizationId,
          projectId: body.projectId ?? null,
          name: body.name,
          description: body.description,
          url: body.url,
          secret: body.secret,
          events: body.events,
          isActive: body.isActive,
        })
        .returning();

      await db.insert(auditLogs).values({
        organizationId,
        actorId: userId,
        action: "extension.install",
        target: `extension:${created.id}`,
        metadata: { name: created.name, url: created.url, events: created.events },
      });

      return reply.code(201).send(toResponse(created));
    },
  );

  app.get(
    "/organizations/:organizationId/extensions",
    {
      config: {
        openapi: {
          operationId: "listExtensions",
          tags: ["Extensions"],
          summary: "Lists the organization's installed extensions; the secret never comes back",
          pathSchema: organizationParams,
          success: { status: 200, description: "Extensions", schema: listOf(ExtensionSchema) },
          errors: [404],
        },
      },
    },
    async (request) => {
      const { organizationId } = organizationParams.parse(request.params);
      await requireMembership(db, request.auth!.userId, organizationId);

      const rows = await db
        .select()
        .from(webhookSubscriptions)
        .where(and(eq(webhookSubscriptions.organizationId, organizationId), isNotNull(webhookSubscriptions.name)))
        .orderBy(asc(webhookSubscriptions.createdAt));
      return { data: rows.map(toResponse) };
    },
  );

  app.delete(
    "/organizations/:organizationId/extensions/:extensionId",
    {
      config: {
        openapi: {
          operationId: "uninstallExtension",
          tags: ["Extensions"],
          summary: "Uninstalls an extension",
          pathSchema: extensionParams,
          success: { status: 204, description: "Extension uninstalled" },
          errors: [403, 404],
        },
      },
    },
    async (request, reply) => {
      const { organizationId, extensionId } = extensionParams.parse(request.params);
      const userId = request.auth!.userId;
      await requireWriteMembership(db, userId, organizationId);

      const [deleted] = await db
        .delete(webhookSubscriptions)
        .where(
          and(
            eq(webhookSubscriptions.id, extensionId),
            eq(webhookSubscriptions.organizationId, organizationId),
            isNotNull(webhookSubscriptions.name),
          ),
        )
        .returning({ id: webhookSubscriptions.id, name: webhookSubscriptions.name });
      if (!deleted) throw new ApiError(404, "extension_not_found", "Extension not found.");

      await db.insert(auditLogs).values({
        organizationId,
        actorId: userId,
        action: "extension.uninstall",
        target: `extension:${deleted.id}`,
        metadata: { name: deleted.name },
      });
      return reply.code(204).send();
    },
  );
};
