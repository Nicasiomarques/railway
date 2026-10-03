import { randomBytes } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { DomainSchema, listOf } from "../openapi/schemas.js";
import { requireInstanceAccess } from "../access.js";
import { ApiError, isUniqueViolation } from "../errors.js";
import { slugify } from "../slug.js";
import type { Db } from "../db/client.js";
import { auditLogs, domains, serviceInstances, services } from "../db/schema.js";
import type { DomainQueue } from "../queue.js";

export const instanceParams = z.object({ instanceId: z.string().uuid() });
export const domainParams = instanceParams.extend({ domainId: z.string().uuid() });

// Hostname totalmente qualificado: rótulos alfanuméricos (com hífen) separados por pontos.
const hostnameRegex = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export const createDomainBody = z
  .object({
    type: z.enum(["auto", "custom"]),
    // Só para type "custom": o hostname do utilizador. Para "auto" é gerado pelo servidor.
    hostname: z.string().trim().toLowerCase().max(255).regex(hostnameRegex, "use um hostname válido, ex.: app.exemplo.com").optional(),
  })
  .superRefine((body, ctx) => {
    if (body.type === "custom" && !body.hostname) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["hostname"], message: "hostname é obrigatório para domínio custom" });
    }
    if (body.type === "auto" && body.hostname) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["hostname"], message: "domínio auto gera o hostname automaticamente; não informe" });
    }
  });

// Tentativas ao gerar um subdomínio automático: só colide se o sufixo aleatório repetir.
const MAX_AUTO_ATTEMPTS = 5;

function randomSuffix(): string {
  return randomBytes(4).toString("hex");
}

type DomainRow = typeof domains.$inferSelect;

async function insertDomain(db: Db, instanceId: string, hostname: string, type: "auto" | "custom"): Promise<DomainRow> {
  const [row] = await db
    .insert(domains)
    .values({ serviceInstanceId: instanceId, hostname, type, tlsState: "pending" })
    .returning();
  return row;
}

export const domainRoutes: FastifyPluginAsync<{ db: Db; baseDomain?: string; queue?: DomainQueue }> = async (
  app,
  { db, baseDomain = "railway.local", queue },
) => {
  app.post(
    "/services/:instanceId/domains",
    {
      config: {
        openapi: {
          operationId: "createDomain",
          tags: ["Domínios"],
          summary: "Cria um domínio para a instância; auto gera o subdomínio, custom recebe o hostname",
          pathSchema: instanceParams,
          bodySchema: createDomainBody,
          success: { status: 201, description: "Domínio criado", schema: DomainSchema },
          errors: [403, 404, 409],
        },
      },
    },
    async (request, reply) => {
      const { instanceId } = instanceParams.parse(request.params);
      const body = createDomainBody.parse(request.body);
      const userId = request.auth!.userId;
      const { organizationId } = await requireInstanceAccess(db, userId, instanceId, { write: true });

      let created: DomainRow;
      if (body.type === "custom") {
        try {
          created = await insertDomain(db, instanceId, body.hostname!, "custom");
        } catch (err) {
          if (isUniqueViolation(err, "domains_hostname_idx")) {
            throw new ApiError(409, "hostname_taken", `O hostname "${body.hostname}" já está em uso.`);
          }
          throw err;
        }
      } else {
        // Subdomínio automático: <slug-do-serviço>-<sufixo aleatório>.apps.<base-domain> (architecture.md §6/§8).
        const [service] = await db
          .select({ name: services.name })
          .from(serviceInstances)
          .innerJoin(services, eq(services.id, serviceInstances.serviceId))
          .where(eq(serviceInstances.id, instanceId));
        const base = slugify(service.name);

        created = await (async () => {
          for (let attempt = 1; ; attempt++) {
            const hostname = `${base}-${randomSuffix()}.apps.${baseDomain}`;
            try {
              return await insertDomain(db, instanceId, hostname, "auto");
            } catch (err) {
              if (isUniqueViolation(err, "domains_hostname_idx") && attempt < MAX_AUTO_ATTEMPTS) continue;
              throw err;
            }
          }
        })();
      }

      await db.insert(auditLogs).values({
        organizationId,
        actorId: userId,
        action: "domain.create",
        target: `domain:${created.id}`,
        metadata: { hostname: created.hostname, type: created.type },
      });

      // Dispara a emissão do certificado; sem fila configurada, o domínio fica pending até ser reprocessado.
      if (queue) {
        try {
          await queue.enqueueIssueCertificate({ domainId: created.id });
        } catch {
          // Best effort: a criação do domínio não falha por causa da fila.
        }
      }

      return reply.code(201).send(created);
    },
  );

  app.get(
    "/services/:instanceId/domains",
    {
      config: {
        openapi: {
          operationId: "listDomains",
          tags: ["Domínios"],
          summary: "Lista os domínios da instância",
          pathSchema: instanceParams,
          success: { status: 200, description: "Domínios", schema: listOf(DomainSchema) },
          errors: [404],
        },
      },
    },
    async (request) => {
      const { instanceId } = instanceParams.parse(request.params);
      await requireInstanceAccess(db, request.auth!.userId, instanceId);

      const rows = await db.select().from(domains).where(eq(domains.serviceInstanceId, instanceId)).orderBy(asc(domains.createdAt));
      return { data: rows };
    },
  );

  app.delete(
    "/services/:instanceId/domains/:domainId",
    {
      config: {
        openapi: {
          operationId: "deleteDomain",
          tags: ["Domínios"],
          summary: "Remove um domínio da instância",
          pathSchema: domainParams,
          success: { status: 204, description: "Domínio removido" },
          errors: [403, 404],
        },
      },
    },
    async (request, reply) => {
      const { instanceId, domainId } = domainParams.parse(request.params);
      const userId = request.auth!.userId;
      const { organizationId } = await requireInstanceAccess(db, userId, instanceId, { write: true });

      const [deleted] = await db
        .delete(domains)
        .where(and(eq(domains.id, domainId), eq(domains.serviceInstanceId, instanceId)))
        .returning({ id: domains.id, hostname: domains.hostname });
      if (!deleted) throw new ApiError(404, "domain_not_found", "Domínio não encontrado.");

      await db.insert(auditLogs).values({
        organizationId,
        actorId: userId,
        action: "domain.delete",
        target: `domain:${deleted.id}`,
        metadata: { hostname: deleted.hostname },
      });
      return reply.code(204).send();
    },
  );
};
