import type { FastifyPluginAsync } from "fastify";
import { asc } from "drizzle-orm";
import { RegionSchema, listOf } from "../openapi/schemas.js";
import type { Db } from "../db/client.js";
import { regions } from "../db/schema.js";

// Reference data (seeded by migration, see db/src/schema.ts's DEFAULT_REGION_ID), so this has no
// create/update/delete -- same spirit as plans.ts for billing.
export const regionRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.get(
    "/regions",
    {
      config: {
        openapi: {
          operationId: "listRegions",
          tags: ["Projects"],
          summary: "Lists the regions a project can be created in",
          success: { status: 200, description: "Regions", schema: listOf(RegionSchema) },
        },
      },
    },
    async () => {
      const rows = await db.select({ id: regions.id, slug: regions.slug, name: regions.name }).from(regions).orderBy(asc(regions.name));
      return { data: rows };
    },
  );
};
