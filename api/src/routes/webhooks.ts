import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { WebhookSubscriptionSchema, listOf } from "../openapi/schemas.js";
import { requireMembership } from "../access.js";
import { ApiError } from "../errors.js";
import type { Db } from "../db/client.js";
import { auditLogs, projects, webhookSubscriptions } from "../db/schema.js";

// NOTE on naming: this is for OUTBOUND webhooks — subscriptions this platform calls out to when
// something happens. It's the inverse of routes/github.ts, which RECEIVES inbound webhooks from
// GitHub; don't confuse the two files.

export const organizationParams = z.object({ organizationId: z.string().uuid() });
export const subscriptionParams = organizationParams.extend({ subscriptionId: z.string().uuid() });

// Event type isn't a closed enum on purpose (roadmap.md Phase 5): new event types are expected to
// be added later without a migration or a client-breaking change. The format is still validated:
// "resource.event", e.g. "deployment.status_changed".
const eventType = z
  .string()
  .regex(/^[a-z]+(\.[a-z0-9_]+)+$/, 'use the form "resource.event", e.g. "deployment.status_changed"');

export const createWebhookSubscriptionBody = z.object({
  // Omitted or null: the subscription applies to every project in the organization.
  projectId: z.string().uuid().nullable().optional(),
  url: z.string().url().max(2048),
  // Signs outbound deliveries (workers/src/webhooks/adapter.ts), the same way api/src/routes/github.ts
  // verifies GitHub's inbound signature — just in the opposite direction. Never returned once set.
  secret: z.string().min(16).max(200),
  events: z.array(eventType).min(1).max(50),
  isActive: z.boolean().default(true),
});

// Never includes `secret`: once set it's write-only, same spirit as variables.ts masking secret values.
function toResponse(row: typeof webhookSubscriptions.$inferSelect) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    url: row.url,
    events: row.events,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function requireWriteMembership(db: Db, userId: string, organizationId: string): Promise<void> {
  const role = await requireMembership(db, userId, organizationId);
  if (role === "viewer") {
    throw new ApiError(403, "forbidden", "The 'viewer' role cannot modify webhook subscriptions.");
  }
}

export const webhookRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.post(
    "/organizations/:organizationId/webhook-subscriptions",
    {
      config: {
        openapi: {
          operationId: "createWebhookSubscription",
          tags: ["Webhooks"],
          summary: "Subscribes a URL to receive outbound webhook deliveries for the given event types",
          pathSchema: organizationParams,
          bodySchema: createWebhookSubscriptionBody,
          success: { status: 201, description: "Subscription created", schema: WebhookSubscriptionSchema },
          errors: [403, 404],
        },
      },
    },
    async (request, reply) => {
      const { organizationId } = organizationParams.parse(request.params);
      const body = createWebhookSubscriptionBody.parse(request.body);
      const userId = request.auth!.userId;
      await requireWriteMembership(db, userId, organizationId);

      if (body.projectId) {
        const [project] = await db
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.id, body.projectId), eq(projects.organizationId, organizationId), isNull(projects.deletedAt)));
        if (!project) throw new ApiError(404, "project_not_found", "Project not found.");
      }

      const [created] = await db
        .insert(webhookSubscriptions)
        .values({
          organizationId,
          projectId: body.projectId ?? null,
          url: body.url,
          secret: body.secret,
          events: body.events,
          isActive: body.isActive,
        })
        .returning();

      // The audit log records the URL and the event types, never the secret.
      await db.insert(auditLogs).values({
        organizationId,
        actorId: userId,
        action: "webhook_subscription.create",
        target: `webhook_subscription:${created.id}`,
        metadata: { url: created.url, projectId: created.projectId, events: created.events },
      });

      return reply.code(201).send(toResponse(created));
    },
  );

  app.get(
    "/organizations/:organizationId/webhook-subscriptions",
    {
      config: {
        openapi: {
          operationId: "listWebhookSubscriptions",
          tags: ["Webhooks"],
          summary: "Lists the organization's outbound webhook subscriptions; the secret never comes back",
          pathSchema: organizationParams,
          success: { status: 200, description: "Subscriptions", schema: listOf(WebhookSubscriptionSchema) },
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
        .where(eq(webhookSubscriptions.organizationId, organizationId))
        .orderBy(asc(webhookSubscriptions.createdAt));
      return { data: rows.map(toResponse) };
    },
  );

  app.delete(
    "/organizations/:organizationId/webhook-subscriptions/:subscriptionId",
    {
      config: {
        openapi: {
          operationId: "deleteWebhookSubscription",
          tags: ["Webhooks"],
          summary: "Removes an outbound webhook subscription",
          pathSchema: subscriptionParams,
          success: { status: 204, description: "Subscription removed" },
          errors: [403, 404],
        },
      },
    },
    async (request, reply) => {
      const { organizationId, subscriptionId } = subscriptionParams.parse(request.params);
      const userId = request.auth!.userId;
      await requireWriteMembership(db, userId, organizationId);

      const [deleted] = await db
        .delete(webhookSubscriptions)
        .where(and(eq(webhookSubscriptions.id, subscriptionId), eq(webhookSubscriptions.organizationId, organizationId)))
        .returning({ id: webhookSubscriptions.id, url: webhookSubscriptions.url });
      if (!deleted) throw new ApiError(404, "webhook_subscription_not_found", "Webhook subscription not found.");

      await db.insert(auditLogs).values({
        organizationId,
        actorId: userId,
        action: "webhook_subscription.delete",
        target: `webhook_subscription:${deleted.id}`,
        metadata: { url: deleted.url },
      });
      return reply.code(204).send();
    },
  );
};
