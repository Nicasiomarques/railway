import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { UsageSummaryItemSchema, listOf } from "../openapi/schemas.js";
import { requireMembership } from "../access.js";
import type { Db } from "../db/client.js";
import { projects, serviceInstances, services, usageEvents } from "../db/schema.js";

const organizationParams = z.object({ organizationId: z.string().uuid() });

const getUsageQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export const usageRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.get(
    "/organizations/:organizationId/usage",
    {
      config: {
        openapi: {
          operationId: "getOrganizationUsage",
          tags: ["Organizations"],
          summary: "Aggregates usage_events by project and service instance over a time range",
          pathSchema: organizationParams,
          querySchema: getUsageQuery,
          success: { status: 200, description: "Usage summary", schema: listOf(UsageSummaryItemSchema) },
          errors: [404],
        },
      },
    },
    async (request) => {
      const { organizationId } = organizationParams.parse(request.params);
      const query = getUsageQuery.parse(request.query);
      // Any role can read usage (same as the audit log): requireMembership's 404 covers both a
      // missing organization and a non-member, without revealing which.
      await requireMembership(db, request.auth!.userId, organizationId);

      // Default: the last 30 days, matching the day-level aggregation window in
      // architecture.md §4 ("1 min -> hour -> day").
      const to = query.to ?? new Date();
      const from = query.from ?? new Date(to.getTime() - THIRTY_DAYS_MS);

      const rows = await db
        .select({
          projectId: projects.id,
          projectName: projects.name,
          serviceInstanceId: usageEvents.serviceInstanceId,
          serviceName: services.name,
          // sum()/count() come back as numeric/bigint, which node-postgres returns as strings;
          // converted to number below, after the query.
          totalReplicaMinutes: sql<string>`coalesce(sum(${usageEvents.value}), 0)`,
          sampleCount: sql<string>`count(*)`,
        })
        .from(usageEvents)
        .innerJoin(projects, eq(projects.id, usageEvents.projectId))
        .leftJoin(serviceInstances, eq(serviceInstances.id, usageEvents.serviceInstanceId))
        .leftJoin(services, eq(services.id, serviceInstances.serviceId))
        .where(
          and(
            eq(projects.organizationId, organizationId),
            isNull(projects.deletedAt),
            // The only metric the usage worker writes today (workers/src/usage/worker.ts); summing
            // it directly gives replica-minutes over the window.
            eq(usageEvents.metric, "replica_minutes"),
            gte(usageEvents.occurredAt, from),
            lte(usageEvents.occurredAt, to),
          ),
        )
        .groupBy(projects.id, projects.name, usageEvents.serviceInstanceId, services.name)
        .orderBy(asc(projects.name), asc(services.name));

      return {
        data: rows.map((row) => ({
          projectId: row.projectId,
          projectName: row.projectName,
          serviceInstanceId: row.serviceInstanceId,
          serviceName: row.serviceName,
          totalReplicaMinutes: Number(row.totalReplicaMinutes),
          sampleCount: Number(row.sampleCount),
        })),
      };
    },
  );
};
