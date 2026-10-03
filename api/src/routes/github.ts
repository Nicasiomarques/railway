import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { ApiError, isUniqueViolation } from "../errors.js";
import type { Keyring } from "../crypto/envelope.js";
import type { DeploymentQueue } from "../queue.js";
import type { Db } from "../db/client.js";
import { environments, githubRepoLinks, githubWebhookDeliveries, serviceInstances, services } from "../db/schema.js";
import { createQueuedDeployment, type Tx } from "./deployments.js";
import {
  NoopGitHubChecksClient,
  NoopGitHubInstallationTokenClient,
  type GitHubChecksClient,
  type GitHubInstallationTokenClient,
} from "../github/clients.js";

// The raw body is preserved by the content-type parser below (scoped to this plugin, doesn't
// affect the other routes): the HMAC check needs the exact bytes GitHub signed, and Fastify by
// default only hands over the already-deserialized JSON.
declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

// delivery_id PK violation: a repeated delivery, already processed before.
const DELIVERY_CONSTRAINT = "github_webhook_deliveries_pkey";

function verifySignature(secret: string, rawBody: Buffer, header: unknown): boolean {
  if (typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(header.slice("sha256=".length), "utf8");
  // Different lengths: timingSafeEqual would throw instead of returning false.
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

// Converts the `environments.branch_rule` glob (e.g. "feature/*") into a full-match regex.
function matchesBranch(glob: string, branch: string): boolean {
  const pattern = `^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`;
  return new RegExp(pattern).test(branch);
}

type PushOutcome = {
  installationId: bigint | null;
  repoId: bigint;
  created: { id: string; serviceInstanceId: string; versionNo: number; commitSha: string | null }[];
  cancelled: { id: string; serviceInstanceId: string }[];
};

// architecture.md §5.2, steps 1-3: resolves the ServiceInstances whose repo and branch match the
// push, and creates a Deployment(Queued) for each one (cancelling whatever was in flight).
async function handlePush(tx: Tx, keyring: Keyring, payload: Record<string, unknown>): Promise<PushOutcome> {
  const repo = payload.repository as { id?: number } | undefined;
  const after = typeof payload.after === "string" ? payload.after : undefined;
  const ref = typeof payload.ref === "string" ? payload.ref : undefined;
  if (!repo?.id || !after || !ref) return { installationId: null, repoId: 0n, created: [], cancelled: [] };

  const repoId = BigInt(repo.id);
  const installation = payload.installation as { id?: number } | undefined;
  const installationId = installation?.id != null ? BigInt(installation.id) : null;
  const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;

  // Branch-deletion push (`after` is all zeros): nothing to deploy.
  if (/^0+$/.test(after)) return { installationId, repoId, created: [], cancelled: [] };

  const headCommit = payload.head_commit as { author?: { name?: string; username?: string } } | undefined;
  const pusher = payload.pusher as { name?: string } | undefined;
  const author = headCommit?.author?.name ?? headCommit?.author?.username ?? pusher?.name ?? null;

  const links = await tx.select({ projectId: githubRepoLinks.projectId }).from(githubRepoLinks).where(eq(githubRepoLinks.repoId, repoId));

  const created: PushOutcome["created"] = [];
  const cancelled: PushOutcome["cancelled"] = [];

  for (const link of links) {
    const envs = await tx
      .select({ id: environments.id, branchRule: environments.branchRule })
      .from(environments)
      .where(and(eq(environments.projectId, link.projectId), isNull(environments.deletedAt)));
    const matchedEnvIds = envs.filter((e) => e.branchRule && matchesBranch(e.branchRule, branch)).map((e) => e.id);
    if (matchedEnvIds.length === 0) continue;

    const instances = await tx
      .select({ id: serviceInstances.id })
      .from(serviceInstances)
      .innerJoin(services, eq(services.id, serviceInstances.serviceId))
      .where(
        and(
          inArray(serviceInstances.environmentId, matchedEnvIds),
          eq(services.source, "github_repo"),
          isNull(serviceInstances.deletedAt),
          isNull(services.deletedAt),
        ),
      );

    for (const instance of instances) {
      const { created: dep, cancelledIds } = await createQueuedDeployment(tx, keyring, {
        instanceId: instance.id,
        trigger: "push",
        commitSha: after,
        branch,
        author,
      });
      created.push({ id: dep.id, serviceInstanceId: instance.id, versionNo: dep.versionNo, commitSha: dep.commitSha });
      cancelled.push(...cancelledIds.map((id) => ({ id, serviceInstanceId: instance.id })));
    }
  }

  return { installationId, repoId, created, cancelled };
}

// `installation`/`installation_repositories` don't carry the platform's project — only GitHub
// knows about the installation and the repo; linking one to a project is something the user does
// in our UI. That's why: "deleted"/"removed" can always remove (it genuinely revokes access), but
// "created"/"added" can only update a link that already exists; there's no way to create a link
// from scratch without a project_id (a NOT NULL column on github_repo_links).
async function handleInstallation(tx: Tx, payload: Record<string, unknown>): Promise<void> {
  const installation = payload.installation as { id?: number } | undefined;
  if (!installation?.id) return;
  const installationId = BigInt(installation.id);

  if (payload.action === "deleted") {
    await tx.delete(githubRepoLinks).where(eq(githubRepoLinks.installationId, installationId));
    return;
  }

  const repos = (payload.repositories as { id: number }[] | undefined) ?? [];
  for (const repo of repos) {
    await tx
      .update(githubRepoLinks)
      .set({ updatedAt: new Date() })
      .where(and(eq(githubRepoLinks.installationId, installationId), eq(githubRepoLinks.repoId, BigInt(repo.id))));
  }
}

async function handleInstallationRepositories(tx: Tx, payload: Record<string, unknown>): Promise<void> {
  const installation = payload.installation as { id?: number } | undefined;
  if (!installation?.id) return;
  const installationId = BigInt(installation.id);

  const removed = (payload.repositories_removed as { id: number }[] | undefined) ?? [];
  for (const repo of removed) {
    await tx
      .delete(githubRepoLinks)
      .where(and(eq(githubRepoLinks.installationId, installationId), eq(githubRepoLinks.repoId, BigInt(repo.id))));
  }

  const added = (payload.repositories_added as { id: number }[] | undefined) ?? [];
  for (const repo of added) {
    await tx
      .update(githubRepoLinks)
      .set({ updatedAt: new Date() })
      .where(and(eq(githubRepoLinks.installationId, installationId), eq(githubRepoLinks.repoId, BigInt(repo.id))));
  }
}

export const githubRoutes: FastifyPluginAsync<{
  db: Db;
  keyring: Keyring;
  queue?: DeploymentQueue;
  webhookSecret?: string;
  installationTokenClient?: GitHubInstallationTokenClient;
  checksClient?: GitHubChecksClient;
}> = async (app, opts) => {
  const { db, keyring, queue } = opts;
  const webhookSecret = opts.webhookSecret ?? process.env.GITHUB_WEBHOOK_SECRET;
  const installationTokenClient = opts.installationTokenClient ?? new NoopGitHubInstallationTokenClient();
  const checksClient = opts.checksClient ?? new NoopGitHubChecksClient();

  // Scoped to this plugin: only the webhook route loses Fastify's default JSON parser.
  // Stores the raw buffer in request.rawBody before deserializing, so the HMAC check can
  // validate exactly the bytes GitHub signed.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request: FastifyRequest, body, done) => {
    const buf = body as Buffer;
    request.rawBody = buf;
    if (buf.length === 0) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(buf.toString("utf8")));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.post(
    "/github/webhooks",
    {
      config: {
        openapi: {
          operationId: "githubWebhook",
          tags: ["GitHub"],
          summary:
            "Receives GitHub App events (push, installation, installation_repositories); authenticates via HMAC, not an API token",
          success: { status: 202, description: "Event accepted" },
          errors: [400, 401],
        },
      },
    },
    async (request, reply) => {
      if (!webhookSecret) {
        throw new ApiError(500, "github_webhook_not_configured", "GITHUB_WEBHOOK_SECRET is not configured.");
      }
      if (!verifySignature(webhookSecret, request.rawBody ?? Buffer.alloc(0), request.headers["x-hub-signature-256"])) {
        throw new ApiError(401, "invalid_signature", "Missing or invalid X-Hub-Signature-256 signature.");
      }

      const deliveryId = request.headers["x-github-delivery"];
      const event = request.headers["x-github-event"];
      if (typeof deliveryId !== "string" || !deliveryId) {
        throw new ApiError(400, "missing_delivery_id", "X-GitHub-Delivery header is required.");
      }
      if (typeof event !== "string" || !event) {
        throw new ApiError(400, "missing_event", "X-GitHub-Event header is required.");
      }

      const payload = (request.body ?? {}) as Record<string, unknown>;
      let pushOutcome: PushOutcome | undefined;

      await db.transaction(async (tx) => {
        try {
          await tx.insert(githubWebhookDeliveries).values({ deliveryId, event });
        } catch (err) {
          if (isUniqueViolation(err, DELIVERY_CONSTRAINT)) return; // repeated delivery: already processed, nothing to do
          throw err;
        }

        if (event === "push") {
          pushOutcome = await handlePush(tx, keyring, payload);
        } else if (event === "installation") {
          await handleInstallation(tx, payload);
        } else if (event === "installation_repositories") {
          await handleInstallationRepositories(tx, payload);
        }
        // Other events (e.g. pull_request) are accepted and ignored at this stage — PR previews are phase 2.
      });

      // Outside the transaction, same as the manual deployments route: the worker only needs to see the row after the commit.
      if (pushOutcome) {
        for (const dep of pushOutcome.created) {
          try {
            await queue?.enqueueReconcile({ serviceInstanceId: dep.serviceInstanceId, versionNo: dep.versionNo });
          } catch (err) {
            request.log.warn({ err, deploymentId: dep.id }, "github push: failed to enqueue the reconciler");
          }
          if (pushOutcome.installationId !== null) {
            await installationTokenClient.getInstallationToken(request.log, pushOutcome.installationId);
            await checksClient.upsertCheckRun(request.log, {
              installationId: pushOutcome.installationId,
              repoId: pushOutcome.repoId,
              commitSha: dep.commitSha ?? "",
              name: "Build",
              status: "queued",
            });
          }
        }
        for (const old of pushOutcome.cancelled) {
          await queue?.enqueueCancelBuild({ deploymentId: old.id, serviceInstanceId: old.serviceInstanceId }).catch((err) => {
            request.log.warn({ err, deploymentId: old.id }, "github push: build cancellation not enqueued");
          });
        }
      }

      return reply.code(202).send({ status: "accepted" });
    },
  );
};
