import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { type DeploymentStatus, transition } from "@railway-like/shared";
import { requireInstanceAccess } from "../access.js";
import { sealEnvSnapshot, type Keyring } from "../crypto/envelope.js";
import { ApiError } from "../errors.js";
import { runIdempotent } from "../idempotency.js";
import { resolveInstanceEnv } from "../env/resolve.js";
import type { DeploymentQueue } from "../queue.js";
import type { Db } from "../db/client.js";
import { auditLogs, buildLogs, deploymentEvents, deployments, envSnapshots, serviceInstances, services } from "../db/schema.js";
import { BuildLogSchema, DeploymentDetailSchema, DeploymentSchema, listOf } from "../openapi/schemas.js";
import { idempotencyKeyHeader } from "./headers.js";

const instanceParams = z.object({ instanceId: z.string().uuid() });
const deploymentParams = z.object({ deploymentId: z.string().uuid() });

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// Exatamente uma das duas origens: imagem pronta por digest, ou commit de um repo que o cluster constrói.
// Qual é obrigatória depende da origem do serviço, e isso é checado na rota.
export const createDeploymentBody = z
  .object({
    imageDigest: z
      .string()
      .regex(/^[a-z0-9]+(?:[._/-][a-z0-9]+)*@sha256:[a-f0-9]{64}$/, "use imagem por digest: repo@sha256:<64 hex>")
      .optional(),
    commitSha: z.string().regex(/^[a-f0-9]{40}$/, "use o SHA completo do commit (40 hex)").optional(),
  })
  .superRefine((body, ctx) => {
    if (!body.imageDigest && !body.commitSha) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "informe imageDigest ou commitSha" });
    }
    if (body.imageDigest && body.commitSha) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "informe só um: imageDigest ou commitSha" });
    }
  });

const listDeploymentsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// Estados em que um deployment ainda pode virar Running. Criar outro cancela estes.
const IN_FLIGHT: DeploymentStatus[] = ["Queued", "Building", "Deploying", "HealthChecking"];

type DeploymentRow = typeof deployments.$inferSelect;
type DeploymentTrigger = DeploymentRow["trigger"];

// Núcleo de criação de deployment (architecture.md §5.2, passos 2-3): versiona, grava o snapshot
// de env e cancela o que estava em voo na mesma instância. Usado pela rota manual (abaixo) e pelo
// webhook de push do GitHub (routes/github.ts) — a única diferença entre as duas origens é o
// trigger e os campos de commit/branch/autor.
export async function createQueuedDeployment(
  tx: Tx,
  keyring: Keyring,
  input: {
    instanceId: string;
    trigger: DeploymentTrigger;
    imageDigest?: string | null;
    commitSha?: string | null;
    branch?: string | null;
    author?: string | null;
  },
): Promise<{ created: DeploymentRow; cancelledIds: string[] }> {
  const { instanceId } = input;

  // Trava a instância: as versões são sequenciais, e duas criações concorrentes não podem repetir uma.
  const [locked] = await tx
    .select({ id: serviceInstances.id })
    .from(serviceInstances)
    .where(eq(serviceInstances.id, instanceId))
    .for("update");
  if (!locked) throw new ApiError(404, "instance_not_found", "Instância não encontrada.");

  const [{ last }] = await tx
    .select({ last: sql<number>`coalesce(max(${deployments.versionNo}), 0)::int` })
    .from(deployments)
    .where(eq(deployments.serviceInstanceId, instanceId));
  const versionNo = last + 1;

  // Snapshot imutável: um rollback volta a este conjunto, não ao estado atual das variáveis.
  const env = await resolveInstanceEnv(tx, keyring, instanceId);
  const snapshotId = randomUUID();
  await tx.insert(envSnapshots).values({
    id: snapshotId,
    serviceInstanceId: instanceId,
    payloadEnc: sealEnvSnapshot(keyring, snapshotId, Object.fromEntries(env.map((v) => [v.key, v.value]))),
  });

  // O novo deployment substitui os que ainda estavam em voo (architecture.md §5.2, passo 3).
  const inFlight = await tx
    .select({ id: deployments.id, status: deployments.status })
    .from(deployments)
    .where(and(eq(deployments.serviceInstanceId, instanceId), inArray(deployments.status, IN_FLIGHT)));
  const cancelledIds: string[] = [];
  for (const old of inFlight) {
    transition(old.status, "Cancelled");
    await tx.update(deployments).set({ status: "Cancelled", updatedAt: new Date() }).where(eq(deployments.id, old.id));
    await tx.insert(deploymentEvents).values({
      deploymentId: old.id,
      fromStatus: old.status,
      toStatus: "Cancelled",
      reason: `substituído pela versão ${versionNo}`,
    });
    cancelledIds.push(old.id);
  }

  const [created] = await tx
    .insert(deployments)
    .values({
      serviceInstanceId: instanceId,
      versionNo,
      status: "Queued",
      trigger: input.trigger,
      imageDigest: input.imageDigest ?? null,
      commitSha: input.commitSha ?? null,
      branch: input.branch ?? null,
      author: input.author ?? null,
      envSnapshotId: snapshotId,
    })
    .returning();
  await tx.insert(deploymentEvents).values({ deploymentId: created.id, fromStatus: null, toStatus: "Queued", reason: "criado" });

  return { created, cancelledIds };
}

function toResponse(d: DeploymentRow) {
  return {
    id: d.id,
    serviceInstanceId: d.serviceInstanceId,
    versionNo: d.versionNo,
    status: d.status,
    trigger: d.trigger,
    imageDigest: d.imageDigest,
    commitSha: d.commitSha,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

export const deploymentRoutes: FastifyPluginAsync<{ db: Db; keyring: Keyring; queue?: DeploymentQueue }> = async (
  app,
  { db, keyring, queue },
) => {
  app.post(
    "/services/:instanceId/deployments",
    {
      config: {
        openapi: {
          operationId: "createDeployment",
          tags: ["Deployments"],
          summary: "Cria um deployment de uma imagem por digest; o snapshot de env é gravado agora",
          pathSchema: instanceParams,
          bodySchema: createDeploymentBody,
          idempotent: true,
          success: { status: 202, description: "Deployment enfileirado", schema: DeploymentSchema },
          errors: [403, 404, 422, 503],
        },
      },
    },
    async (request, reply) => {
      const { instanceId } = instanceParams.parse(request.params);
      const body = createDeploymentBody.parse(request.body);
      const userId = request.auth!.userId;
      const { organizationId } = await requireInstanceAccess(db, userId, instanceId, { write: true });

      const [source] = await db
        .select({ source: services.source })
        .from(serviceInstances)
        .innerJoin(services, eq(services.id, serviceInstances.serviceId))
        .where(eq(serviceInstances.id, instanceId));
      if (source.source === "github_repo" && !body.commitSha) {
        throw new ApiError(400, "source_mismatch", "Serviço github_repo exige commitSha, não imageDigest.");
      }
      if (source.source !== "github_repo" && !body.imageDigest) {
        throw new ApiError(400, "source_mismatch", "Este serviço exige imageDigest, não commitSha.");
      }

      // Preenchido dentro da transação; usado só depois do commit (na repetição fica vazio, e não precisa).
      const cancelledIds: string[] = [];
      const result = await runIdempotent(db, {
        userId,
        key: idempotencyKeyHeader(request.headers),
        payload: { instanceId, ...body },
        run: async (tx) => {
          const { created, cancelledIds: cancelled } = await createQueuedDeployment(tx, keyring, {
            instanceId,
            trigger: "manual",
            imageDigest: body.imageDigest ?? null,
            commitSha: body.commitSha ?? null,
          });
          cancelledIds.push(...cancelled);
          await tx.insert(auditLogs).values({
            organizationId,
            actorId: userId,
            action: "deployment.create",
            target: `deployment:${created.id}`,
          });
          return { status: 202, body: toResponse(created) };
        },
      });

      // Enfileira depois do commit: o worker precisa enxergar a linha. Repetir com a mesma Idempotency-Key
      // enfileira de novo; o jobId por versão deduplica, e o reconciliador é idempotente.
      const dep = result.body as ReturnType<typeof toResponse>;
      try {
        if (!queue) throw new Error("fila de deployments não configurada");
        await queue.enqueueReconcile({ serviceInstanceId: dep.serviceInstanceId, versionNo: dep.versionNo });
      } catch {
        // Sem job o deployment ficaria em Queued para sempre. Marca como Failed para o estado refletir a realidade.
        await db.transaction(async (tx) => {
          const updated = await tx
            .update(deployments)
            .set({ status: "Failed", updatedAt: new Date() })
            .where(and(eq(deployments.id, dep.id), eq(deployments.status, "Queued")))
            .returning({ id: deployments.id });
          if (updated.length > 0) {
            await tx.insert(deploymentEvents).values({
              deploymentId: dep.id,
              fromStatus: "Queued",
              toStatus: "Failed",
              reason: "falha ao enfileirar",
            });
          }
        });
        throw new ApiError(
          503,
          "queue_unavailable",
          "Não foi possível enfileirar o deployment; ele foi marcado como Failed. Crie um novo.",
        );
      }

      // Apaga os builds dos deployments que esta versão substituiu. Best effort: se falhar, o Job morre pelo timeout.
      for (const id of cancelledIds) {
        await queue?.enqueueCancelBuild({ deploymentId: id, serviceInstanceId: instanceId }).catch(() => undefined);
      }

      return reply.code(result.status).send(result.body);
    },
  );

  app.get(
    "/services/:instanceId/deployments",
    {
      config: {
        openapi: {
          operationId: "listDeployments",
          tags: ["Deployments"],
          summary: "Lista os deployments de uma instância, do mais recente para o mais antigo",
          pathSchema: instanceParams,
          querySchema: listDeploymentsQuery,
          success: { status: 200, description: "Deployments", schema: listOf(DeploymentSchema) },
          errors: [404],
        },
      },
    },
    async (request) => {
      const { instanceId } = instanceParams.parse(request.params);
      const query = listDeploymentsQuery.parse(request.query);
      await requireInstanceAccess(db, request.auth!.userId, instanceId);

      const rows = await db
        .select()
        .from(deployments)
        .where(eq(deployments.serviceInstanceId, instanceId))
        .orderBy(desc(deployments.versionNo))
        .limit(query.limit);
      return { data: rows.map(toResponse) };
    },
  );

  app.get(
    "/deployments/:deploymentId",
    {
      config: {
        openapi: {
          operationId: "getDeployment",
          tags: ["Deployments"],
          summary: "Detalha um deployment com o histórico de estados",
          pathSchema: deploymentParams,
          success: { status: 200, description: "Deployment", schema: DeploymentDetailSchema },
          errors: [404],
        },
      },
    },
    async (request) => {
      const { deploymentId } = deploymentParams.parse(request.params);
      const [dep] = await db.select().from(deployments).where(eq(deployments.id, deploymentId));
      // Sem acesso e inexistente devolvem o mesmo erro: não revela que o id existe.
      const notFound = () => new ApiError(404, "deployment_not_found", "Deployment não encontrado.");
      if (!dep) throw notFound();
      await requireInstanceAccess(db, request.auth!.userId, dep.serviceInstanceId).catch(() => {
        throw notFound();
      });

      const events = await db
        .select()
        .from(deploymentEvents)
        .where(eq(deploymentEvents.deploymentId, deploymentId))
        .orderBy(deploymentEvents.occurredAt, deploymentEvents.id);
      return {
        ...toResponse(dep),
        events: events.map((e) => ({ fromStatus: e.fromStatus, toStatus: e.toStatus, reason: e.reason, occurredAt: e.occurredAt })),
      };
    },
  );

  // Cancela um deployment que ainda não chegou a Running. Running só sai por substituição (ver architecture §5.2).
  app.post(
    "/deployments/:deploymentId/cancel",
    {
      config: {
        openapi: {
          operationId: "cancelDeployment",
          tags: ["Deployments"],
          summary: "Cancela um deployment que ainda não está Running; o build em andamento é apagado",
          pathSchema: deploymentParams,
          success: { status: 200, description: "Deployment cancelado", schema: DeploymentSchema },
          errors: [403, 404, 409],
        },
      },
    },
    async (request) => {
      const { deploymentId } = deploymentParams.parse(request.params);
      const notFound = () => new ApiError(404, "deployment_not_found", "Deployment não encontrado.");
      const [dep] = await db.select().from(deployments).where(eq(deployments.id, deploymentId));
      if (!dep) throw notFound();

      const access = await requireInstanceAccess(db, request.auth!.userId, dep.serviceInstanceId, { write: true }).catch((err) => {
        if (err instanceof ApiError && err.status === 403) throw err;
        throw notFound();
      });

      if (!IN_FLIGHT.includes(dep.status)) {
        throw new ApiError(409, "not_cancellable", `Deployment em ${dep.status} não pode ser cancelado.`);
      }

      const [cancelled] = await db.transaction(async (tx) => {
        transition(dep.status, "Cancelled");
        // Condicionado ao status lido: se o worker avançou nesse meio tempo, a escrita não acontece.
        const rows = await tx
          .update(deployments)
          .set({ status: "Cancelled", updatedAt: new Date() })
          .where(and(eq(deployments.id, deploymentId), eq(deployments.status, dep.status)))
          .returning();
        if (rows.length === 0) throw new ApiError(409, "state_changed", "O deployment mudou de estado; tente de novo.");

        await tx.insert(deploymentEvents).values({
          deploymentId,
          fromStatus: dep.status,
          toStatus: "Cancelled",
          reason: "cancelado pelo usuário",
        });
        await tx.insert(auditLogs).values({
          organizationId: access.organizationId,
          actorId: request.auth!.userId,
          action: "deployment.cancel",
          target: `deployment:${deploymentId}`,
        });
        return rows;
      });

      // Sempre enfileira: o worker apaga o Job se houver um e ignora se não houver (imagens não têm Job).
      await queue?.enqueueCancelBuild({ deploymentId, serviceInstanceId: dep.serviceInstanceId }).catch((err) => {
        request.log.warn({ err, deploymentId }, "cancelamento do build não enfileirado; o Job expira pelo timeout");
      });
      return toResponse(cancelled);
    },
  );

  // Último retrato dos logs do build. Vazio enquanto o build não começou (ou para deployments de imagem).
  app.get(
    "/deployments/:deploymentId/logs",
    {
      config: {
        openapi: {
          operationId: "getDeploymentLogs",
          tags: ["Deployments"],
          summary: "Logs do build do deployment (gate, clone e build); o conteúdo é o último retrato salvo",
          pathSchema: deploymentParams,
          success: { status: 200, description: "Logs", schema: BuildLogSchema },
          errors: [404],
        },
      },
    },
    async (request) => {
      const { deploymentId } = deploymentParams.parse(request.params);
      const notFound = () => new ApiError(404, "deployment_not_found", "Deployment não encontrado.");
      const [dep] = await db.select({ serviceInstanceId: deployments.serviceInstanceId }).from(deployments).where(eq(deployments.id, deploymentId));
      if (!dep) throw notFound();
      await requireInstanceAccess(db, request.auth!.userId, dep.serviceInstanceId).catch(() => {
        throw notFound();
      });

      const [row] = await db.select().from(buildLogs).where(eq(buildLogs.deploymentId, deploymentId));
      return { content: row?.content ?? "", updatedAt: row?.updatedAt ?? null };
    },
  );
};
