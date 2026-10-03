import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { VariableListItemSchema, ResolvedVariableSchema, VariableUpsertSchema, listOf } from "../openapi/schemas.js";
import { requireInstanceAccess } from "../access.js";
import { ApiError } from "../errors.js";
import { decryptValue, encryptValue, type Keyring } from "../crypto/envelope.js";
import type { Db } from "../db/client.js";
import { auditLogs, variables } from "../db/schema.js";
import { resolveInstanceEnv, validateReferences } from "../env/resolve.js";

export const instanceParams = z.object({ instanceId: z.string().uuid() });
export const keyParams = instanceParams.extend({
  key: z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/, "use uppercase letters, numbers and _"),
});
export const upsertBody = z.object({
  value: z.string().max(10_000),
  isSecret: z.boolean().default(false),
});

// The context authenticates the value to the instance and the key: copying the ciphertext to another one breaks decryption.
const contextFor = (instanceId: string, key: string) => `variable:${instanceId}:${key}`;

export const variableRoutes: FastifyPluginAsync<{ db: Db; keyring: Keyring }> = async (app, { db, keyring }) => {
  app.get(
    "/services/:instanceId/variables",
    {
      config: {
        openapi: {
          operationId: "listVariables",
          tags: ["Variables"],
          summary: "Lists the instance's variables; secrets come back without a value",
          pathSchema: instanceParams,
          success: { status: 200, description: "Variables", schema: listOf(VariableListItemSchema) },
          errors: [404],
        },
      },
    },
    async (request) => {
    const { instanceId } = instanceParams.parse(request.params);
    await requireInstanceAccess(db, request.auth!.userId, instanceId);

    const rows = await db
      .select()
      .from(variables)
      .where(and(eq(variables.scope, "service_instance"), eq(variables.serviceInstanceId, instanceId)))
      .orderBy(asc(variables.key));

    // Secrets never come back in plain text; the client only sees that they exist.
    return {
      data: rows.map((v) => ({
        key: v.key,
        isSecret: v.isSecret,
        version: v.version,
        updatedAt: v.updatedAt,
        value: v.isSecret ? null : decryptValue(keyring, v.valueEnc, contextFor(instanceId, v.key)),
      })),
    };
  });

  // The instance's final environment, with references resolved. Secrets come back masked.
  app.get(
    "/services/:instanceId/env",
    {
      config: {
        openapi: {
          operationId: "getInstanceEnv",
          tags: ["Variables"],
          summary: "The instance's final environment, with references resolved",
          pathSchema: instanceParams,
          success: { status: 200, description: "Resolved environment", schema: listOf(ResolvedVariableSchema) },
          errors: [404, 422],
        },
      },
    },
    async (request) => {
    const { instanceId } = instanceParams.parse(request.params);
    await requireInstanceAccess(db, request.auth!.userId, instanceId);

    const resolved = await resolveInstanceEnv(db, keyring, instanceId);
    return {
      data: resolved.map((v) => ({ key: v.key, isSecret: v.isSecret, value: v.isSecret ? null : v.value })),
    };
  });

  app.put(
    "/services/:instanceId/variables/:key",
    {
      config: {
        openapi: {
          operationId: "upsertVariable",
          tags: ["Variables"],
          summary: "Creates or updates one of the instance's variables",
          pathSchema: keyParams,
          bodySchema: upsertBody,
          success: { status: 200, description: "Variable saved", schema: VariableUpsertSchema },
          errors: [403, 404, 422],
        },
      },
    },
    async (request) => {
    const { instanceId, key } = keyParams.parse(request.params);
    const body = upsertBody.parse(request.body);
    validateReferences(body.value);
    const userId = request.auth!.userId;
    const { organizationId } = await requireInstanceAccess(db, userId, instanceId, { write: true });

    const valueEnc = encryptValue(keyring, body.value, contextFor(instanceId, key));
    const [row] = await db
      .insert(variables)
      .values({
        scope: "service_instance",
        serviceInstanceId: instanceId,
        key,
        valueEnc,
        isSecret: body.isSecret,
      })
      .onConflictDoUpdate({
        target: [variables.serviceInstanceId, variables.key],
        set: {
          valueEnc,
          isSecret: body.isSecret,
          version: sql`${variables.version} + 1`,
          updatedAt: new Date(),
        },
      })
      .returning();

    // The audit log records the key and the type, never the value.
    await db.insert(auditLogs).values({
      organizationId,
      actorId: userId,
      action: "variable.upsert",
      target: `service_instance:${instanceId}:${key}`,
      metadata: { isSecret: body.isSecret, version: row.version },
    });

    return { key, isSecret: row.isSecret, version: row.version, updatedAt: row.updatedAt };
  });

  app.delete(
    "/services/:instanceId/variables/:key",
    {
      config: {
        openapi: {
          operationId: "deleteVariable",
          tags: ["Variables"],
          summary: "Removes one of the instance's variables",
          pathSchema: keyParams,
          success: { status: 204, description: "Variable removed" },
          errors: [403, 404],
        },
      },
    },
    async (request, reply) => {
    const { instanceId, key } = keyParams.parse(request.params);
    const userId = request.auth!.userId;
    const { organizationId } = await requireInstanceAccess(db, userId, instanceId, { write: true });

    const [deleted] = await db
      .delete(variables)
      .where(and(eq(variables.scope, "service_instance"), eq(variables.serviceInstanceId, instanceId), eq(variables.key, key)))
      .returning({ id: variables.id });
    if (!deleted) throw new ApiError(404, "variable_not_found", "Variable not found.");

    await db.insert(auditLogs).values({
      organizationId,
      actorId: userId,
      action: "variable.delete",
      target: `service_instance:${instanceId}:${key}`,
    });
    return reply.code(204).send();
  });
};
