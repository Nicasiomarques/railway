import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireProjectAccess } from "../access.js";
import { runIdempotent } from "../idempotency.js";
import { encryptValue, type Keyring } from "../crypto/envelope.js";
import type { Db } from "../db/client.js";
import { variables } from "../db/schema.js";
import { ServiceWithInstancesSchema, listOf } from "../openapi/schemas.js";
import { parseImportManifest, type ImportedService } from "../import/manifest.js";
import { projectParams, createServiceAndInstances, type Tx } from "./services.js";
import { idempotencyKeyHeader } from "./headers.js";

const importBody = z.object({
  provider: z.enum(["heroku", "render", "railway"]),
  // The manifest's raw text: app.json (Heroku, JSON), render.yaml (Render, YAML) or a project
  // export (Railway, JSON) - see api/src/import/manifest.ts for the exact shape each expects.
  manifest: z.string().min(1).max(100_000),
});

const contextFor = (instanceId: string, key: string) => `variable:${instanceId}:${key}`;

// Imported manifests (Heroku app.json, Render render.yaml, Railway export) don't carry an
// isSecret flag of their own, unlike variables created through PUT /services/:id/variables
// (variables.ts's upsertBody). Without this, every imported value - including things like
// DATABASE_URL or SECRET_KEY_BASE - would land as isSecret:false and come back in plain text
// to any member with read access. Same heuristic a human would use when naming these keys.
const LIKELY_SECRET_KEY_RE = /(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|APIKEY|CREDENTIAL|_DSN$|_URL$|CONNECTION_STRING|CERT|CLIENT_SECRET)/i;

function isLikelySecretKey(key: string): boolean {
  return LIKELY_SECRET_KEY_RE.test(key);
}

async function importVariables(tx: Tx, keyring: Keyring, instanceId: string, vars: Record<string, string>): Promise<void> {
  for (const [key, value] of Object.entries(vars)) {
    await tx.insert(variables).values({
      scope: "service_instance",
      serviceInstanceId: instanceId,
      key,
      valueEnc: encryptValue(keyring, value, contextFor(instanceId, key)),
      isSecret: isLikelySecretKey(key),
    });
  }
}

async function importService(
  tx: Tx,
  keyring: Keyring,
  { organizationId, userId, projectId, service }: { organizationId: string; userId: string; projectId: string; service: ImportedService },
) {
  const result = await createServiceAndInstances(tx, {
    organizationId,
    userId,
    projectId,
    service: {
      name: service.name,
      kind: service.kind,
      source: service.repoUrl ? "github_repo" : "image",
      repoUrl: service.repoUrl,
      schedule: service.schedule,
    },
  });
  const instances = result.body.instances as { id: string }[];
  for (const instance of instances) {
    await importVariables(tx, keyring, instance.id, service.variables);
  }
  return result.body;
}

export const importRoutes: FastifyPluginAsync<{ db: Db; keyring: Keyring }> = async (app, { db, keyring }) => {
  // Imports every service declared in the manifest into the project, atomically: either all of
  // them land (one instance per existing environment, like a normal service creation) or, on a
  // parse error or a name collision partway through, none do.
  app.post(
    "/projects/:projectId/import",
    {
      config: {
        openapi: {
          operationId: "importProject",
          tags: ["Import"],
          summary: "Imports services from a Heroku, Render or Railway manifest",
          pathSchema: projectParams,
          bodySchema: importBody,
          idempotent: true,
          success: { status: 201, description: "Imported services", schema: listOf(ServiceWithInstancesSchema) },
          errors: [400, 403, 404, 409],
        },
      },
    },
    async (request, reply) => {
      const { projectId } = projectParams.parse(request.params);
      const body = importBody.parse(request.body);
      const userId = request.auth!.userId;
      const { organizationId } = await requireProjectAccess(db, userId, projectId, { write: true });

      const imported = parseImportManifest(body.provider, body.manifest);

      const result = await runIdempotent(db, {
        userId,
        key: idempotencyKeyHeader(request.headers),
        payload: { projectId, ...body },
        run: async (tx) => {
          const created = [];
          for (const service of imported) {
            created.push(await importService(tx, keyring, { organizationId, userId, projectId, service }));
          }
          return { status: 201 as const, body: { data: created } };
        },
      });

      return reply.code(result.status).send(result.body);
    },
  );
};
