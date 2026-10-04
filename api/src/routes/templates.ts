import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { MARKETPLACE_TEMPLATES, findMarketplaceTemplate } from "@railway-like/shared";
import { requireProjectAccess } from "../access.js";
import { ApiError } from "../errors.js";
import { runIdempotent } from "../idempotency.js";
import type { Db } from "../db/client.js";
import { ServiceWithInstancesSchema, MarketplaceTemplateSchema, listOf } from "../openapi/schemas.js";
import { idempotencyKeyHeader } from "./headers.js";
import { projectParams, createServiceAndInstances } from "./services.js";

const templateParams = projectParams.extend({ source: z.string() });

const deployTemplateBody = z.object({
  // Defaults to the template's own name, lowercased and hyphenated (e.g. "PostgreSQL" -> "postgresql").
  name: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "use lowercase letters, numbers and hyphens")
    .optional(),
});

export const templateRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  // Static catalog (shared/src/templates.ts): no DB round-trip, same way auth.ts's login doesn't
  // need one to validate a token format.
  app.get(
    "/templates",
    {
      config: {
        openapi: {
          operationId: "listTemplates",
          tags: ["Templates"],
          summary: "Lists the templates available in the marketplace",
          success: { status: 200, description: "Templates", schema: listOf(MarketplaceTemplateSchema) },
          errors: [],
        },
      },
    },
    async () => ({ data: MARKETPLACE_TEMPLATES }),
  );

  // Creates a service (and one instance per environment) preconfigured from the template's
  // kind/source, the same shape `POST /projects/:projectId/services` would produce by hand -
  // this route exists so a caller doesn't need to know the `*_template` source enum values.
  app.post(
    "/projects/:projectId/templates/:source/deploy",
    {
      config: {
        openapi: {
          operationId: "deployTemplate",
          tags: ["Templates"],
          summary: "Deploys a marketplace template as a new service in the project",
          pathSchema: templateParams,
          bodySchema: deployTemplateBody,
          idempotent: true,
          success: { status: 201, description: "Service created from template", schema: ServiceWithInstancesSchema },
          errors: [403, 404, 409],
        },
      },
    },
    async (request, reply) => {
      const { projectId, source } = templateParams.parse(request.params);
      const body = deployTemplateBody.parse(request.body);
      const userId = request.auth!.userId;
      const { organizationId } = await requireProjectAccess(db, userId, projectId, { write: true });

      const template = findMarketplaceTemplate(source);
      if (!template) throw new ApiError(404, "template_not_found", `No marketplace template named "${source}".`);
      const name = body.name ?? template.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

      const result = await runIdempotent(db, {
        userId,
        key: idempotencyKeyHeader(request.headers),
        payload: { projectId, source, name },
        run: (tx) =>
          createServiceAndInstances(tx, {
            organizationId,
            userId,
            projectId,
            service: { name, kind: template.kind, source: template.source },
          }),
      });

      return reply.code(result.status).send(result.body);
    },
  );
};
