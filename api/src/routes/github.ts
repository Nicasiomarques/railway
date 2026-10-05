import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { ApiError, isUniqueViolation } from "../errors.js";
import { decryptValue, encryptValue, type Keyring } from "../crypto/envelope.js";
import type { DeploymentQueue } from "../queue.js";
import type { Db } from "../db/client.js";
import { environments, githubRepoLinks, githubWebhookDeliveries, serviceInstances, services, variables } from "../db/schema.js";
import { createQueuedDeployment, type Tx } from "./deployments.js";
import {
  NoopGitHubChecksClient,
  NoopGitHubInstallationTokenClient,
  NoopGitHubPrCommentClient,
  type GitHubChecksClient,
  type GitHubInstallationTokenClient,
  type GitHubPrCommentClient,
} from "../github/clients.js";

// Preview environments (architecture.md §8 / §4): TTL grace period applied on `pull_request.closed`
// instead of deleting the environment right away. The actual cleanup is the "preview janitor"
// worker (architecture.md §3), out of scope here — this only stamps `ttl_at`.
const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;

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

// Preview environment name/slug for a PR, e.g. "pr-42" (architecture.md §8). Also the lookup key:
// `environments_project_name_idx` is unique per project, so this doubles as the "does a preview
// for this PR already exist" check.
function previewEnvName(prNumber: number): string {
  return `pr-${prNumber}`;
}

// The preview's parent environment (architecture.md §8: "inherits Staging variables, with
// override"). Decision: fall back to Production when the project has no Staging environment yet
// (every project is created with a Production environment — see routes/projects.ts — but Staging
// is optional today), rather than leaving the preview parentless.
//
// Exported: api/src/routes/environments.ts reuses the same fallback for an ephemeral CI
// environment's parent (roadmap.md Phase 5) -- a CI environment inherits variables exactly like a
// PR preview does, it's just created directly through the API instead of by the GitHub webhook.
export async function resolvePreviewParent(tx: Tx, projectId: string): Promise<{ id: string } | null> {
  const [staging] = await tx
    .select({ id: environments.id })
    .from(environments)
    .where(and(eq(environments.projectId, projectId), eq(environments.type, "staging"), isNull(environments.deletedAt)))
    .limit(1);
  if (staging) return staging;

  const [production] = await tx
    .select({ id: environments.id })
    .from(environments)
    .where(and(eq(environments.projectId, projectId), eq(environments.type, "production"), isNull(environments.deletedAt)))
    .limit(1);
  return production ?? null;
}

// Copies the parent's service_instance-scoped variables onto a freshly created preview instance.
//
// Why an explicit copy instead of relying on `parentEnvironmentId`: `resolveInstanceEnv`
// (api/src/env/resolve.ts) only ever reads `scope: "service_instance"` rows for the exact
// instance it's given — it never looks up `environment`- or `project`-scoped variables, and
// never follows `parentEnvironmentId`. There is no environment-level inheritance implemented
// anywhere in the API today (confirmed: no other code reads `variables.environmentId`), so
// "inherits Staging variables" has to be materialized as real `service_instance` rows on the
// preview instance, copied from the matching service instance in the parent environment.
//
// "With override": only keys the preview instance doesn't already have are copied, so an
// existing preview-specific variable is never clobbered. In practice this only matters if this
// is called more than once for the same instance; today it's only called right after creating
// the instance, when it has no variables yet.
async function copyInstanceVariables(tx: Tx, keyring: Keyring, fromInstanceId: string, toInstanceId: string): Promise<void> {
  const parentVars = await tx
    .select()
    .from(variables)
    .where(and(eq(variables.scope, "service_instance"), eq(variables.serviceInstanceId, fromInstanceId)));
  if (parentVars.length === 0) return;

  const existing = await tx
    .select({ key: variables.key })
    .from(variables)
    .where(and(eq(variables.scope, "service_instance"), eq(variables.serviceInstanceId, toInstanceId)));
  const existingKeys = new Set(existing.map((v) => v.key));

  const toInsert = parentVars
    .filter((v) => !existingKeys.has(v.key))
    .map((v) => {
      const plaintext = decryptValue(keyring, v.valueEnc, `variable:${fromInstanceId}:${v.key}`);
      return {
        scope: "service_instance" as const,
        serviceInstanceId: toInstanceId,
        key: v.key,
        valueEnc: encryptValue(keyring, plaintext, `variable:${toInstanceId}:${v.key}`),
        isSecret: v.isSecret,
      };
    });
  if (toInsert.length > 0) await tx.insert(variables).values(toInsert);
}

type PullRequestStatus = "created" | "updated" | "scheduled_for_removal" | "skipped";

type PullRequestOutcome = {
  installationId: bigint | null;
  repoId: bigint;
  prNumber: number;
  status: PullRequestStatus;
  created: { id: string; serviceInstanceId: string; versionNo: number; commitSha: string | null }[];
};

const emptyPullRequestOutcome = (): PullRequestOutcome => ({
  installationId: null,
  repoId: 0n,
  prNumber: 0,
  status: "skipped",
  created: [],
});

// architecture.md §8: `opened`/`synchronize`/`reopened` creates/updates a `pr-N` preview
// environment (and its deployments); `closed` only schedules removal (TTL), never deletes.
async function handlePullRequest(tx: Tx, keyring: Keyring, payload: Record<string, unknown>): Promise<PullRequestOutcome> {
  const repo = payload.repository as { id?: number } | undefined;
  const pr = payload.pull_request as { number?: number; head?: { sha?: string; ref?: string }; user?: { login?: string } } | undefined;
  const action = typeof payload.action === "string" ? payload.action : undefined;
  if (!repo?.id || !pr?.number || !action) return emptyPullRequestOutcome();

  const repoId = BigInt(repo.id);
  const installation = payload.installation as { id?: number } | undefined;
  const installationId = installation?.id != null ? BigInt(installation.id) : null;
  const prNumber = pr.number;
  const envName = previewEnvName(prNumber);

  const links = await tx.select({ projectId: githubRepoLinks.projectId }).from(githubRepoLinks).where(eq(githubRepoLinks.repoId, repoId));

  if (action === "closed") {
    let found = false;
    for (const link of links) {
      const [env] = await tx
        .select({ id: environments.id })
        .from(environments)
        .where(and(eq(environments.projectId, link.projectId), eq(environments.name, envName), isNull(environments.deletedAt)));
      if (!env) continue;
      found = true;
      await tx
        .update(environments)
        .set({ ttlAt: new Date(Date.now() + PREVIEW_TTL_MS), updatedAt: new Date() })
        .where(eq(environments.id, env.id));
    }
    return { installationId, repoId, prNumber, status: found ? "scheduled_for_removal" : "skipped", created: [] };
  }

  if (action !== "opened" && action !== "synchronize" && action !== "reopened") return emptyPullRequestOutcome();

  const headSha = pr.head?.sha;
  const headRef = pr.head?.ref;
  if (!headSha || !headRef) return emptyPullRequestOutcome();
  const author = pr.user?.login ?? null;

  const created: PullRequestOutcome["created"] = [];
  let anyCreatedEnv = false;

  for (const link of links) {
    const [existingEnv] = await tx
      .select({ id: environments.id, parentEnvironmentId: environments.parentEnvironmentId })
      .from(environments)
      .where(and(eq(environments.projectId, link.projectId), eq(environments.name, envName), isNull(environments.deletedAt)));

    let env: { id: string; parentEnvironmentId: string | null };
    if (existingEnv) {
      env = existingEnv;
      // Reopened/synced: branch_rule is exact (not a glob), and a revived env (previously
      // scheduled for removal, now reopened) must have its TTL cleared.
      await tx
        .update(environments)
        .set({ branchRule: headRef, ttlAt: null, updatedAt: new Date() })
        .where(eq(environments.id, env.id));
    } else {
      const parent = await resolvePreviewParent(tx, link.projectId);
      if (!parent) continue; // no Staging/Production to inherit from yet: nothing to preview against

      const [createdEnv] = await tx
        .insert(environments)
        .values({
          projectId: link.projectId,
          name: envName,
          type: "preview",
          parentEnvironmentId: parent.id,
          branchRule: headRef,
        })
        .returning({ id: environments.id, parentEnvironmentId: environments.parentEnvironmentId });
      env = createdEnv;
      anyCreatedEnv = true;
    }

    // Same source filter the `push` handler uses: only github_repo services get instances/deployments.
    const projectServices = await tx
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.projectId, link.projectId), eq(services.source, "github_repo"), isNull(services.deletedAt)));
    if (projectServices.length === 0) continue;
    const serviceIds = projectServices.map((s) => s.id);

    const existingInstances = await tx
      .select({ id: serviceInstances.id, serviceId: serviceInstances.serviceId })
      .from(serviceInstances)
      .where(
        and(
          inArray(serviceInstances.serviceId, serviceIds),
          eq(serviceInstances.environmentId, env.id),
          isNull(serviceInstances.deletedAt),
        ),
      );
    const existingServiceIds = new Set(existingInstances.map((i) => i.serviceId));
    const missingServices = projectServices.filter((s) => !existingServiceIds.has(s.id));

    // Same instance-creation shape services.ts uses when a service gets an instance per environment.
    const newInstances = missingServices.length
      ? await tx
          .insert(serviceInstances)
          .values(missingServices.map((s) => ({ serviceId: s.id, environmentId: env.id })))
          .returning({ id: serviceInstances.id, serviceId: serviceInstances.serviceId })
      : [];

    if (newInstances.length > 0 && env.parentEnvironmentId) {
      const parentInstances = await tx
        .select({ id: serviceInstances.id, serviceId: serviceInstances.serviceId })
        .from(serviceInstances)
        .where(
          and(
            inArray(
              serviceInstances.serviceId,
              missingServices.map((s) => s.id),
            ),
            eq(serviceInstances.environmentId, env.parentEnvironmentId),
            isNull(serviceInstances.deletedAt),
          ),
        );
      const parentInstanceByService = new Map(parentInstances.map((i) => [i.serviceId, i.id]));
      for (const instance of newInstances) {
        const parentInstanceId = parentInstanceByService.get(instance.serviceId);
        if (parentInstanceId) await copyInstanceVariables(tx, keyring, parentInstanceId, instance.id);
      }
    }

    for (const instance of [...existingInstances, ...newInstances]) {
      // The deployment_trigger enum has no dedicated "pull_request" value; "push" is the closest
      // existing trigger (a PR-driven preview deploy is still "a commit landed on a branch").
      const { created: dep } = await createQueuedDeployment(tx, keyring, {
        instanceId: instance.id,
        trigger: "push",
        commitSha: headSha,
        branch: headRef,
        author,
      });
      created.push({ id: dep.id, serviceInstanceId: instance.id, versionNo: dep.versionNo, commitSha: dep.commitSha });
    }
  }

  return { installationId, repoId, prNumber, status: anyCreatedEnv ? "created" : created.length > 0 ? "updated" : "skipped", created };
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
  prCommentClient?: GitHubPrCommentClient;
}> = async (app, opts) => {
  const { db, keyring, queue } = opts;
  const webhookSecret = opts.webhookSecret ?? process.env.GITHUB_WEBHOOK_SECRET;
  const installationTokenClient = opts.installationTokenClient ?? new NoopGitHubInstallationTokenClient();
  const checksClient = opts.checksClient ?? new NoopGitHubChecksClient();
  const prCommentClient = opts.prCommentClient ?? new NoopGitHubPrCommentClient();

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
            "Receives GitHub App events (push, pull_request, installation, installation_repositories); authenticates via HMAC, not an API token",
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
      let prOutcome: PullRequestOutcome | undefined;

      await db.transaction(async (tx) => {
        try {
          await tx.insert(githubWebhookDeliveries).values({ deliveryId, event });
        } catch (err) {
          if (isUniqueViolation(err, DELIVERY_CONSTRAINT)) return; // repeated delivery: already processed, nothing to do
          throw err;
        }

        if (event === "push") {
          pushOutcome = await handlePush(tx, keyring, payload);
        } else if (event === "pull_request") {
          prOutcome = await handlePullRequest(tx, keyring, payload);
        } else if (event === "installation") {
          await handleInstallation(tx, payload);
        } else if (event === "installation_repositories") {
          await handleInstallationRepositories(tx, payload);
        }
        // Other events are accepted and ignored at this stage.
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
            const token = await installationTokenClient.getInstallationToken(request.log, pushOutcome.installationId);
            await checksClient.upsertCheckRun(request.log, {
              installationId: pushOutcome.installationId,
              token,
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

      if (prOutcome) {
        for (const dep of prOutcome.created) {
          try {
            await queue?.enqueueReconcile({ serviceInstanceId: dep.serviceInstanceId, versionNo: dep.versionNo });
          } catch (err) {
            request.log.warn({ err, deploymentId: dep.id }, "github pull_request: failed to enqueue the reconciler");
          }
        }

        // architecture.md §8: a single comment on the PR, edited on each update (never one per push/sync).
        const statusLabel: Partial<Record<PullRequestStatus, string>> = {
          created: "created",
          updated: "updated",
          scheduled_for_removal: "scheduled for removal",
        };
        const label = statusLabel[prOutcome.status];
        if (prOutcome.installationId !== null && label) {
          await prCommentClient.upsertPrComment(request.log, {
            installationId: prOutcome.installationId,
            repoId: prOutcome.repoId,
            prNumber: prOutcome.prNumber,
            body: `Preview environment pr-${prOutcome.prNumber}: ${label}`,
          });
        }
      }

      return reply.code(202).send({ status: "accepted" });
    },
  );
};
