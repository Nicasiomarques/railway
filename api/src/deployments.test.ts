import { sql } from "drizzle-orm";
import { openEnvSnapshot } from "@railway-like/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { testKeyring } from "./crypto/testing.js";
import { db } from "./db/client.js";
import { createUserWithToken } from "./db/fixtures.js";
import { buildLogs, deploymentEvents, envSnapshots, memberships, deployments } from "./db/schema.js";

const keyring = testKeyring();

class FakeQueue {
  calls: { serviceInstanceId: string; versionNo: number }[] = [];
  cancels: { deploymentId: string; serviceInstanceId: string }[] = [];
  fail = false;
  async enqueueReconcile(data: { serviceInstanceId: string; versionNo: number }) {
    if (this.fail) throw new Error("redis is down");
    this.calls.push(data);
  }
  async enqueueCancelBuild(data: { deploymentId: string; serviceInstanceId: string }) {
    this.cancels.push(data);
  }
}

// A single instance: the app holds the reference, so the test resets the state instead of swapping the object.
const queue = new FakeQueue();
const app = buildApp(db, { keyring, queue });

beforeEach(async () => {
  queue.calls = [];
  queue.cancels = [];
  queue.fail = false;
  const { rows } = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public' and tablename <> '__drizzle_migrations'`,
  );
  await db.execute(sql.raw(`truncate ${rows.map((r) => `"${r.tablename}"`).join(", ")} restart identity cascade`));
});

afterAll(async () => {
  await app.close();
});

const auth = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });
const DIGEST = `registry.local/app@sha256:${"a".repeat(64)}`;
const DIGEST_2 = `registry.local/app@sha256:${"b".repeat(64)}`;

// Project with one service: returns the production environment's instance.
async function setupInstance() {
  const { token, org } = await createUserWithToken(db);
  const project = await app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: auth(token),
    payload: { organizationId: org.id, name: "Web" },
  });
  const projectId = project.json().id as string;
  const service = await app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/services`,
    headers: auth(token),
    payload: { name: "app", kind: "web", source: "image" },
  });
  const instanceId = service.json().instances[0].id as string;
  return { token, orgId: org.id, instanceId };
}

const deploy = (token: string, instanceId: string, imageDigest = DIGEST, extra: Record<string, string> = {}) =>
  app.inject({
    method: "POST",
    url: `/v1/services/${instanceId}/deployments`,
    headers: auth(token, extra),
    payload: { imageDigest },
  });

describe("creating a deployment", () => {
  it("starts as Queued, with version 1, and enqueues the reconciler", async () => {
    const { token, instanceId } = await setupInstance();

    const res = await deploy(token, instanceId);

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ serviceInstanceId: instanceId, versionNo: 1, status: "Queued", imageDigest: DIGEST });
    expect(queue.calls).toEqual([{ serviceInstanceId: instanceId, versionNo: 1 }]);
  });

  it("stores an encrypted env snapshot with the resolved variables", async () => {
    const { token, instanceId } = await setupInstance();
    await app.inject({
      method: "PUT",
      url: `/v1/services/${instanceId}/variables/GREETING`,
      headers: auth(token),
      payload: { value: "hello" },
    });
    await app.inject({
      method: "PUT",
      url: `/v1/services/${instanceId}/variables/DB_PASSWORD`,
      headers: auth(token),
      payload: { value: "secret", isSecret: true },
    });

    const res = await deploy(token, instanceId);
    const [dep] = await db.select().from(deployments);
    const [snap] = await db.select().from(envSnapshots);

    expect(res.statusCode).toBe(202);
    expect(dep.envSnapshotId).toBe(snap.id);
    // The payload in the database isn't plain text, and only opens with the snapshot's own context.
    expect(snap.payloadEnc).not.toContain("secret");
    expect(openEnvSnapshot(keyring, snap.id, snap.payloadEnc)).toEqual({ GREETING: "hello", DB_PASSWORD: "secret" });
  });

  it("a new version cancels the one in flight and preserves the history", async () => {
    const { token, instanceId } = await setupInstance();
    await deploy(token, instanceId, DIGEST);

    const second = await deploy(token, instanceId, DIGEST_2);

    expect(second.json()).toMatchObject({ versionNo: 2, status: "Queued" });
    const rows = await db.select().from(deployments);
    expect(rows.find((r) => r.versionNo === 1)!.status).toBe("Cancelled");
    expect(rows.find((r) => r.versionNo === 2)!.status).toBe("Queued");
  });

  it("an image without a digest is rejected", async () => {
    const { token, instanceId } = await setupInstance();
    const res = await deploy(token, instanceId, "registry.local/app:latest");
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("validation_failed");
  });

  it("viewer cannot create a deployment", async () => {
    const { token, orgId, instanceId } = await setupInstance();
    await db.update(memberships).set({ role: "viewer" }).where(sql`organization_id = ${orgId}`);

    const res = await deploy(token, instanceId);

    expect(res.statusCode).toBe(403);
  });

  it("a repeated Idempotency-Key returns the same deployment, without creating another one", async () => {
    const { token, instanceId } = await setupInstance();
    const first = await deploy(token, instanceId, DIGEST, { "idempotency-key": "k-1" });
    const again = await deploy(token, instanceId, DIGEST, { "idempotency-key": "k-1" });

    expect(again.json().id).toBe(first.json().id);
    expect(await db.select().from(deployments)).toHaveLength(1);
  });

  it("fails to enqueue: responds 503 and marks the deployment as Failed", async () => {
    const { token, instanceId } = await setupInstance();
    queue.fail = true;

    const res = await deploy(token, instanceId);

    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("queue_unavailable");
    const [dep] = await db.select().from(deployments);
    expect(dep.status).toBe("Failed");
  });
});

describe("querying deployments", () => {
  it("lists from most recent to oldest", async () => {
    const { token, instanceId } = await setupInstance();
    await deploy(token, instanceId, DIGEST);
    await deploy(token, instanceId, DIGEST_2);

    const res = await app.inject({ method: "GET", url: `/v1/services/${instanceId}/deployments`, headers: auth(token) });

    expect(res.json().data.map((d: { versionNo: number }) => d.versionNo)).toEqual([2, 1]);
  });

  it("the detail view carries the state history", async () => {
    const { token, instanceId } = await setupInstance();
    const created = await deploy(token, instanceId);
    const id = created.json().id as string;

    const res = await app.inject({ method: "GET", url: `/v1/deployments/${id}`, headers: auth(token) });

    expect(res.statusCode).toBe(200);
    expect(res.json().events).toEqual([
      expect.objectContaining({ fromStatus: null, toStatus: "Queued", reason: "created" }),
    ]);
  });

  it("another organization gets the same 404 as a nonexistent id", async () => {
    const owner = await setupInstance();
    const created = await deploy(owner.token, owner.instanceId);
    const outsider = await createUserWithToken(db);

    const foreign = await app.inject({
      method: "GET",
      url: `/v1/deployments/${created.json().id}`,
      headers: auth(outsider.token),
    });
    const missing = await app.inject({
      method: "GET",
      url: `/v1/deployments/00000000-0000-0000-0000-000000000000`,
      headers: auth(outsider.token),
    });

    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject({ code: "deployment_not_found" });
    expect(missing.json()).toMatchObject({ code: "deployment_not_found" });
  });
});

describe("service and deployment source", () => {
  const SHA = "c6ba3ae5b6c700cc04950ff8389d8a37f31e5913";

  async function githubInstance() {
    const { token, org } = await createUserWithToken(db);
    const project = await app.inject({ method: "POST", url: "/v1/projects", headers: auth(token), payload: { organizationId: org.id, name: "Web" } });
    const service = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.json().id}/services`,
      headers: auth(token),
      payload: { name: "app", kind: "web", source: "github_repo", repoUrl: "http://host.k3d.internal:8189/app.git" },
    });
    return { token, instanceId: service.json().instances[0].id as string };
  }

  it("a github_repo service requires repoUrl and doesn't accept an image without a build", async () => {
    const { token, org } = await createUserWithToken(db);
    const project = await app.inject({ method: "POST", url: "/v1/projects", headers: auth(token), payload: { organizationId: org.id, name: "Web" } });
    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.json().id}/services`,
      headers: auth(token),
      payload: { name: "app", kind: "web", source: "github_repo" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toMatch(/repoUrl is required/);
  });

  it("repoUrl on an image service is rejected", async () => {
    const { token, org } = await createUserWithToken(db);
    const project = await app.inject({ method: "POST", url: "/v1/projects", headers: auth(token), payload: { organizationId: org.id, name: "Web" } });
    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.json().id}/services`,
      headers: auth(token),
      payload: { name: "app", kind: "web", source: "image", repoUrl: "https://example.com/x.git" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("github_repo accepts commitSha and stores the commit", async () => {
    const { token, instanceId } = await githubInstance();
    const res = await app.inject({
      method: "POST",
      url: `/v1/services/${instanceId}/deployments`,
      headers: auth(token),
      payload: { commitSha: SHA },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ commitSha: SHA, imageDigest: null, status: "Queued" });
  });

  it("github_repo rejects imageDigest directly", async () => {
    const { token, instanceId } = await githubInstance();
    const res = await deploy(token, instanceId, DIGEST);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("source_mismatch");
  });

  it("an image service rejects commitSha", async () => {
    const { token, instanceId } = await setupInstance();
    const res = await app.inject({
      method: "POST",
      url: `/v1/services/${instanceId}/deployments`,
      headers: auth(token),
      payload: { commitSha: SHA },
    });
    expect(res.json().code).toBe("source_mismatch");
  });

  it("a body with both sources, or with neither, is rejected", async () => {
    const { token, instanceId } = await setupInstance();
    const both = await app.inject({
      method: "POST",
      url: `/v1/services/${instanceId}/deployments`,
      headers: auth(token),
      payload: { imageDigest: DIGEST, commitSha: SHA },
    });
    const none = await app.inject({ method: "POST", url: `/v1/services/${instanceId}/deployments`, headers: auth(token), payload: {} });
    expect(both.statusCode).toBe(400);
    expect(none.statusCode).toBe(400);
  });
});

describe("cancellation", () => {
  it("a new version enqueues the cancellation of the build it superseded", async () => {
    const { token, instanceId } = await setupInstance();
    const first = await deploy(token, instanceId, DIGEST);
    await deploy(token, instanceId, DIGEST_2);

    expect(queue.cancels).toEqual([{ deploymentId: first.json().id, serviceInstanceId: instanceId }]);
  });

  it("POST cancel marks it Cancelled, records the event and enqueues the build cancellation", async () => {
    const { token, instanceId } = await setupInstance();
    const created = await deploy(token, instanceId, DIGEST);
    const id = created.json().id as string;

    const res = await app.inject({ method: "POST", url: `/v1/deployments/${id}/cancel`, headers: auth(token) });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, status: "Cancelled" });
    const events = await db.select().from(deploymentEvents).where(sql`deployment_id = ${id}`);
    expect(events.map((e) => e.reason)).toContain("cancelled by user");
    expect(queue.cancels).toEqual([{ deploymentId: id, serviceInstanceId: instanceId }]);
  });

  it("cancelling again is rejected with 409", async () => {
    const { token, instanceId } = await setupInstance();
    const id = (await deploy(token, instanceId, DIGEST)).json().id as string;
    await app.inject({ method: "POST", url: `/v1/deployments/${id}/cancel`, headers: auth(token) });

    const again = await app.inject({ method: "POST", url: `/v1/deployments/${id}/cancel`, headers: auth(token) });

    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("not_cancellable");
  });

  it("Running cannot be cancelled", async () => {
    const { token, instanceId } = await setupInstance();
    const id = (await deploy(token, instanceId, DIGEST)).json().id as string;
    await db.update(deployments).set({ status: "Running" }).where(sql`id = ${id}`);

    const res = await app.inject({ method: "POST", url: `/v1/deployments/${id}/cancel`, headers: auth(token) });

    expect(res.statusCode).toBe(409);
  });

  it("viewer cannot cancel a deployment", async () => {
    const { token, orgId, instanceId } = await setupInstance();
    const id = (await deploy(token, instanceId, DIGEST)).json().id as string;
    await db.update(memberships).set({ role: "viewer" }).where(sql`organization_id = ${orgId}`);

    const res = await app.inject({ method: "POST", url: `/v1/deployments/${id}/cancel`, headers: auth(token) });

    expect(res.statusCode).toBe(403);
  });
});

describe("build logs", () => {
  it("returns the last saved snapshot, or empty before any reading", async () => {
    const { token, instanceId } = await setupInstance();
    const id = (await deploy(token, instanceId, DIGEST)).json().id as string;

    const empty = await app.inject({ method: "GET", url: `/v1/deployments/${id}/logs`, headers: auth(token) });
    expect(empty.json()).toEqual({ content: "", updatedAt: null });

    await db.insert(buildLogs).values({ deploymentId: id, content: "=== build ===\nok" });
    const saved = await app.inject({ method: "GET", url: `/v1/deployments/${id}/logs`, headers: auth(token) });
    expect(saved.json().content).toBe("=== build ===\nok");
    expect(saved.json().updatedAt).not.toBeNull();
  });

  it("someone without access gets the same 404 as a nonexistent id", async () => {
    const owner = await setupInstance();
    const id = (await deploy(owner.token, owner.instanceId, DIGEST)).json().id as string;
    await db.insert(buildLogs).values({ deploymentId: id, content: "secret?" });
    const outsider = await createUserWithToken(db);

    const foreign = await app.inject({ method: "GET", url: `/v1/deployments/${id}/logs`, headers: auth(outsider.token) });

    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().code).toBe("deployment_not_found");
  });
});
