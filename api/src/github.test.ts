import { randomUUID, createHmac } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { testKeyring } from "./crypto/testing.js";
import { db } from "./db/client.js";
import { createUserWithToken } from "./db/fixtures.js";
import { deployments, environments, githubRepoLinks, serviceInstances } from "./db/schema.js";
import type { GitHubPrCommentInput } from "./github/clients.js";

const keyring = testKeyring();
const WEBHOOK_SECRET = "t3st-s3cr3t";

class FakeQueue {
  calls: { serviceInstanceId: string; versionNo: number }[] = [];
  cancels: { deploymentId: string; serviceInstanceId: string }[] = [];
  async enqueueReconcile(data: { serviceInstanceId: string; versionNo: number }) {
    this.calls.push(data);
  }
  async enqueueCancelBuild(data: { deploymentId: string; serviceInstanceId: string }) {
    this.cancels.push(data);
  }
}

class FakePrCommentClient {
  calls: GitHubPrCommentInput[] = [];
  async upsertPrComment(_log: unknown, input: GitHubPrCommentInput) {
    this.calls.push(input);
  }
}

const queue = new FakeQueue();
const prComments = new FakePrCommentClient();
const app = buildApp(db, { keyring, queue, githubWebhookSecret: WEBHOOK_SECRET, githubPrCommentClient: prComments });

beforeEach(async () => {
  queue.calls = [];
  queue.cancels = [];
  prComments.calls = [];
  const { rows } = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public' and tablename <> '__drizzle_migrations'`,
  );
  await db.execute(sql.raw(`truncate ${rows.map((r) => `"${r.tablename}"`).join(", ")} restart identity cascade`));
});

afterAll(async () => {
  await app.close();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const REPO_ID = 555111;
const INSTALLATION_ID = 777222;
const SHA = "c6ba3ae5b6c700cc04950ff8389d8a37f31e5913";

function sign(body: string): string {
  return `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`;
}

function sendWebhook(
  body: unknown,
  opts: { event?: string; deliveryId?: string; signatureOverride?: string } = {},
) {
  const raw = JSON.stringify(body);
  const deliveryId = opts.deliveryId ?? randomUUID();
  return app.inject({
    method: "POST",
    url: "/v1/github/webhooks",
    headers: {
      "content-type": "application/json",
      "x-github-event": opts.event ?? "push",
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": opts.signatureOverride ?? sign(raw),
    },
    payload: raw,
  });
}

// Project with a github_repo service linked to the repo via github_repo_links, in the production
// env (branch_rule = "main"). Returns everything the push tests need.
async function setupGithubProject() {
  const { token, org } = await createUserWithToken(db);
  const project = await app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: auth(token),
    payload: { organizationId: org.id, name: "Web" },
  });
  const projectId = project.json().id as string;

  // Every project is created already with a "production" environment; only branch_rule is missing.
  await db.update(environments).set({ branchRule: "main" }).where(eq(environments.projectId, projectId));

  const service = await app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/services`,
    headers: auth(token),
    payload: { name: "app", kind: "web", source: "github_repo", repoUrl: "https://github.com/acme/app.git" },
  });
  const instanceId = service.json().instances[0].id as string;

  // Repo → project link: today it only exists via direct insertion (no link endpoint at this stage).
  await db.insert(githubRepoLinks).values({
    projectId,
    installationId: BigInt(INSTALLATION_ID),
    repoId: BigInt(REPO_ID),
  });

  return { token, projectId, instanceId };
}

const pushPayload = (overrides: Record<string, unknown> = {}) => ({
  ref: "refs/heads/main",
  after: SHA,
  repository: { id: REPO_ID },
  installation: { id: INSTALLATION_ID },
  head_commit: { author: { name: "Dev" } },
  pusher: { name: "dev" },
  ...overrides,
});

const PR_NUMBER = 42;
const PR_BRANCH = "feature/login";

const prPayload = (overrides: Record<string, unknown> = {}) => ({
  action: "opened",
  pull_request: { number: PR_NUMBER, head: { sha: SHA, ref: PR_BRANCH }, user: { login: "dev" } },
  repository: { id: REPO_ID },
  installation: { id: INSTALLATION_ID },
  ...overrides,
});

describe("GitHub webhook", () => {
  it("invalid signature is rejected with 401, and nothing is processed", async () => {
    await setupGithubProject();

    const res = await sendWebhook(pushPayload(), { signatureOverride: "sha256=" + "0".repeat(64) });

    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("invalid_signature");
    expect(await db.select().from(deployments)).toHaveLength(0);
  });

  it("missing signature is rejected with 401", async () => {
    const raw = JSON.stringify(pushPayload());
    const res = await app.inject({
      method: "POST",
      url: "/v1/github/webhooks",
      headers: { "content-type": "application/json", "x-github-event": "push", "x-github-delivery": randomUUID() },
      payload: raw,
    });
    expect(res.statusCode).toBe(401);
  });

  it("known push, with a valid signature: creates the deployment in Queued and enqueues the reconciler", async () => {
    const { instanceId } = await setupGithubProject();

    const res = await sendWebhook(pushPayload());

    expect(res.statusCode).toBe(202);
    const rows = await db.select().from(deployments);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      serviceInstanceId: instanceId,
      status: "Queued",
      trigger: "push",
      commitSha: SHA,
      branch: "main",
      author: "Dev",
      versionNo: 1,
    });
    expect(queue.calls).toEqual([{ serviceInstanceId: instanceId, versionNo: 1 }]);
  });

  it("a repeated delivery (same X-GitHub-Delivery) doesn't duplicate the deployment", async () => {
    await setupGithubProject();
    const deliveryId = randomUUID();

    const first = await sendWebhook(pushPayload(), { deliveryId });
    const second = await sendWebhook(pushPayload(), { deliveryId });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(await db.select().from(deployments)).toHaveLength(1);
    expect(queue.calls).toHaveLength(1);
  });

  it("a push to a branch with no matching environment creates no deployment", async () => {
    await setupGithubProject();

    const res = await sendWebhook(pushPayload({ ref: "refs/heads/no-environment" }));

    expect(res.statusCode).toBe(202);
    expect(await db.select().from(deployments)).toHaveLength(0);
  });

  it("a push supersedes the in-flight deployment of the same instance (cancels the previous one)", async () => {
    const { instanceId } = await setupGithubProject();
    await sendWebhook(pushPayload());

    const second = await sendWebhook(pushPayload({ after: "a".repeat(40) }));

    expect(second.statusCode).toBe(202);
    const rows = await db.select().from(deployments);
    expect(rows.find((r) => r.versionNo === 1)!.status).toBe("Cancelled");
    expect(rows.find((r) => r.versionNo === 2)!.status).toBe("Queued");
    expect(queue.cancels).toEqual([{ deploymentId: rows.find((r) => r.versionNo === 1)!.id, serviceInstanceId: instanceId }]);
  });

  it("a deleted installation removes its links, and a subsequent push is ignored", async () => {
    await setupGithubProject();

    const del = await sendWebhook(
      { action: "deleted", installation: { id: INSTALLATION_ID } },
      { event: "installation" },
    );
    expect(del.statusCode).toBe(202);
    expect(await db.select().from(githubRepoLinks)).toHaveLength(0);

    const push = await sendWebhook(pushPayload());
    expect(push.statusCode).toBe(202);
    expect(await db.select().from(deployments)).toHaveLength(0);
  });

  it("a removed installation_repositories entry removes only the link for the removed repo", async () => {
    await setupGithubProject();

    const res = await sendWebhook(
      { installation: { id: INSTALLATION_ID }, repositories_removed: [{ id: REPO_ID }], repositories_added: [] },
      { event: "installation_repositories" },
    );

    expect(res.statusCode).toBe(202);
    expect(await db.select().from(githubRepoLinks)).toHaveLength(0);
  });

  // architecture.md §8: PR previews (phase 2).
  describe("pull_request (PR previews)", () => {
    it("a PR opened creates a preview environment (parented on Production, no Staging yet), its service instance and a deployment, and comments on the PR", async () => {
      const { projectId } = await setupGithubProject();

      const res = await sendWebhook(prPayload({ action: "opened" }), { event: "pull_request" });
      expect(res.statusCode).toBe(202);

      const [previewEnv] = await db
        .select()
        .from(environments)
        .where(and(eq(environments.projectId, projectId), eq(environments.name, "pr-42")));
      expect(previewEnv).toMatchObject({ type: "preview", branchRule: PR_BRANCH, ttlAt: null });

      const [productionEnv] = await db
        .select()
        .from(environments)
        .where(and(eq(environments.projectId, projectId), eq(environments.type, "production")));
      // No Staging environment exists for this project, so the preview falls back to Production as its parent.
      expect(previewEnv.parentEnvironmentId).toBe(productionEnv.id);

      const instances = await db.select().from(serviceInstances).where(eq(serviceInstances.environmentId, previewEnv.id));
      expect(instances).toHaveLength(1);

      const rows = await db.select().from(deployments).where(eq(deployments.serviceInstanceId, instances[0].id));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "Queued", trigger: "push", commitSha: SHA, branch: PR_BRANCH, author: "dev", versionNo: 1 });

      expect(queue.calls).toEqual([{ serviceInstanceId: instances[0].id, versionNo: 1 }]);
      expect(prComments.calls).toHaveLength(1);
      expect(prComments.calls[0]).toMatchObject({ prNumber: PR_NUMBER, body: "Preview environment pr-42: created" });
    });

    it("a PR synchronized (new commit) reuses the same preview environment and creates a new deployment", async () => {
      const { projectId } = await setupGithubProject();
      await sendWebhook(prPayload({ action: "opened" }), { event: "pull_request" });

      const newSha = "b".repeat(40);
      const res = await sendWebhook(
        prPayload({ action: "synchronize", pull_request: { number: PR_NUMBER, head: { sha: newSha, ref: PR_BRANCH }, user: { login: "dev" } } }),
        { event: "pull_request" },
      );
      expect(res.statusCode).toBe(202);

      // Still a single preview environment: synchronize reuses it instead of creating another one.
      const envs = await db
        .select()
        .from(environments)
        .where(and(eq(environments.projectId, projectId), eq(environments.name, "pr-42")));
      expect(envs).toHaveLength(1);

      const instances = await db.select().from(serviceInstances).where(eq(serviceInstances.environmentId, envs[0].id));
      expect(instances).toHaveLength(1);

      const rows = await db
        .select()
        .from(deployments)
        .where(eq(deployments.serviceInstanceId, instances[0].id))
        .orderBy(asc(deployments.versionNo));
      expect(rows).toHaveLength(2);
      expect(rows[0].commitSha).toBe(SHA);
      expect(rows[1]).toMatchObject({ commitSha: newSha, status: "Queued" });

      expect(queue.calls).toHaveLength(2);
      expect(prComments.calls.at(-1)).toMatchObject({ body: "Preview environment pr-42: updated" });
    });

    it("a PR closed schedules the preview environment's removal (ttl_at) without deleting it or its instances", async () => {
      const { projectId } = await setupGithubProject();
      await sendWebhook(prPayload({ action: "opened" }), { event: "pull_request" });
      const queueCallsAfterOpen = queue.calls.length;
      const beforeClose = Date.now();

      const res = await sendWebhook(prPayload({ action: "closed" }), { event: "pull_request" });
      expect(res.statusCode).toBe(202);

      const [env] = await db
        .select()
        .from(environments)
        .where(and(eq(environments.projectId, projectId), eq(environments.name, "pr-42")));
      expect(env.deletedAt).toBeNull();
      expect(env.ttlAt).not.toBeNull();
      expect(env.ttlAt!.getTime()).toBeGreaterThan(beforeClose);

      const instances = await db.select().from(serviceInstances).where(eq(serviceInstances.environmentId, env.id));
      expect(instances).toHaveLength(1);
      expect(instances[0].deletedAt).toBeNull();

      // No new deployment: closing a PR doesn't deploy anything (the reconciler call count doesn't move past the opened PR's).
      expect(queue.calls).toHaveLength(queueCallsAfterOpen);
      expect(prComments.calls.at(-1)).toMatchObject({ body: "Preview environment pr-42: scheduled for removal" });
    });
  });
});
