import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireInstanceAccess } from "../access.js";
import { ApiError } from "../errors.js";
import { decryptValue, encryptValue, type Keyring } from "../crypto/envelope.js";
import type { Db } from "../db/client.js";
import { auditLogs, variables } from "../db/schema.js";

const instanceParams = z.object({ instanceId: z.string().uuid() });
const keyParams = instanceParams.extend({
  key: z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/, "use letras maiúsculas, números e _"),
});
const upsertBody = z.object({
  value: z.string().max(10_000),
  isSecret: z.boolean().default(false),
});

// O contexto autentica o valor à instância e à chave: copiar o ciphertext para outra quebra a decifragem.
const contextFor = (instanceId: string, key: string) => `variable:${instanceId}:${key}`;

export const variableRoutes: FastifyPluginAsync<{ db: Db; keyring: Keyring }> = async (app, { db, keyring }) => {
  app.get("/services/:instanceId/variables", async (request) => {
    const { instanceId } = instanceParams.parse(request.params);
    await requireInstanceAccess(db, request.auth!.userId, instanceId);

    const rows = await db
      .select()
      .from(variables)
      .where(and(eq(variables.scope, "service_instance"), eq(variables.serviceInstanceId, instanceId)))
      .orderBy(asc(variables.key));

    // Secrets nunca voltam em texto puro; o cliente vê só que existem.
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

  app.put("/services/:instanceId/variables/:key", async (request) => {
    const { instanceId, key } = keyParams.parse(request.params);
    const body = upsertBody.parse(request.body);
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

    // Auditoria registra a chave e o tipo, nunca o valor.
    await db.insert(auditLogs).values({
      organizationId,
      actorId: userId,
      action: "variable.upsert",
      target: `service_instance:${instanceId}:${key}`,
      metadata: { isSecret: body.isSecret, version: row.version },
    });

    return { key, isSecret: row.isSecret, version: row.version, updatedAt: row.updatedAt };
  });

  app.delete("/services/:instanceId/variables/:key", async (request, reply) => {
    const { instanceId, key } = keyParams.parse(request.params);
    const userId = request.auth!.userId;
    const { organizationId } = await requireInstanceAccess(db, userId, instanceId, { write: true });

    const [deleted] = await db
      .delete(variables)
      .where(and(eq(variables.scope, "service_instance"), eq(variables.serviceInstanceId, instanceId), eq(variables.key, key)))
      .returning({ id: variables.id });
    if (!deleted) throw new ApiError(404, "variable_not_found", "Variável não encontrada.");

    await db.insert(auditLogs).values({
      organizationId,
      actorId: userId,
      action: "variable.delete",
      target: `service_instance:${instanceId}:${key}`,
    });
    return reply.code(204).send();
  });
};
