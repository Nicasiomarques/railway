import { sql } from "drizzle-orm";
import { openEnvSnapshot } from "@railway-like/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { testKeyring } from "./crypto/testing.js";
import { db } from "./db/client.js";
import { createUserWithToken } from "./db/fixtures.js";
import { auditLogs, buildLogs, deploymentEvents, envSnapshots, memberships, deployments } from "./db/schema.js";
import { workloadName, type RuntimeReader, type WorkloadRef, type WorkloadStatus } from "./runtime.js";

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

// Fake runtime for the SSE and metrics tests: tests populate `statuses`/`logs` by workload name.
class FakeRuntime implements RuntimeReader {
  statuses = new Map<string, WorkloadStatus | null>();
  logs = new Map<string, string[]>();
  async getStatus(ref: WorkloadRef): Promise<WorkloadStatus | null> {
    return this.statuses.get(ref.name) ?? null;
  }
  async *tailLogs(ref: WorkloadRef): AsyncIterable<string> {
    for (const line of this.logs.get(ref.name) ?? []) yield line;
  }
}

// A single instance: the app holds the reference, so the test resets the state instead of swapping the object.
const queue = new FakeQueue();
const runtime = new FakeRuntime();
const app = buildApp(db, { keyring, queue, runtime });

beforeEach(async () => {
  queue.calls = [];
  queue.cancels = [];
  queue.fail = false;
  runtime.statuses.clear();
  runtime.logs.clear();
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

async function setupInstanceWithSource(kind: string, source: string) {
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
    payload: { name: "app", kind, source },
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

  it("a postgres_template service resolves its image without the caller passing one", async () => {
    const { token, instanceId } = await setupInstanceWithSource("postgres", "postgres_template");
    const res = await app.inject({ method: "POST", url: `/v1/services/${instanceId}/deployments`, headers: auth(token), payload: {} });
    expect(res.statusCode).toBe(202);
    expect(res.json().imageDigest).toMatch(/^docker\.io\/library\/postgres@sha256:[a-f0-9]{64}$/);
  });

  it("a redis_template service resolves its image without the caller passing one", async () => {
    const { token, instanceId } = await setupInstanceWithSource("redis", "redis_template");
    const res = await app.inject({ method: "POST", url: `/v1/services/${instanceId}/deployments`, headers: auth(token), payload: {} });
    expect(res.statusCode).toBe(202);
    expect(res.json().imageDigest).toMatch(/^docker\.io\/library\/redis@sha256:[a-f0-9]{64}$/);
  });

  it("an explicit imageDigest on a template service overrides the pinned one", async () => {
    const { token, instanceId } = await setupInstanceWithSource("postgres", "postgres_template");
    const res = await deploy(token, instanceId, DIGEST);
    expect(res.statusCode).toBe(202);
    expect(res.json().imageDigest).toBe(DIGEST);
  });

  it("a postgres_template service rejects commitSha even though an image would resolve", async () => {
    const { token, instanceId } = await setupInstanceWithSource("postgres", "postgres_template");
    const res = await app.inject({
      method: "POST",
      url: `/v1/services/${instanceId}/deployments`,
      headers: auth(token),
      payload: { commitSha: SHA },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("source_mismatch");
  });

  it("a minio_template service without a pinned or explicit image is rejected", async () => {
    const { token, instanceId } = await setupInstanceWithSource("object_storage", "minio_template");
    const res = await app.inject({ method: "POST", url: `/v1/services/${instanceId}/deployments`, headers: auth(token), payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("source_mismatch");
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

describe("rollback", () => {
  const rollback = (token: string, deploymentId: string) =>
    // The literal URL the CLI calls (cli/src/commands/rollback.ts): a colon action, not a sub-resource.
    app.inject({ method: "POST", url: `/v1/deployments/${deploymentId}:rollback`, headers: auth(token) });

  it("the exact CLI URL (colon action, no slash) reaches the route", async () => {
    const { token, instanceId } = await setupInstance();
    const id = (await deploy(token, instanceId, DIGEST)).json().id as string;
    await db.update(deployments).set({ status: "Running" }).where(sql`id = ${id}`);

    const res = await rollback(token, id);

    expect(res.statusCode).toBe(202);
  });

  it("creates a new version with the same image and EnvSnapshot as the target, not the current env", async () => {
    const { token, instanceId } = await setupInstance();
    await app.inject({
      method: "PUT",
      url: `/v1/services/${instanceId}/variables/GREETING`,
      headers: auth(token),
      payload: { value: "v1-value" },
    });
    const v1Id = (await deploy(token, instanceId, DIGEST)).json().id as string;
    await db.update(deployments).set({ status: "Running" }).where(sql`id = ${v1Id}`);
    const [v1] = await db.select().from(deployments).where(sql`id = ${v1Id}`);

    // v2 supersedes v1 (now Superseded, since we promote it below) and changes the env.
    await app.inject({
      method: "PUT",
      url: `/v1/services/${instanceId}/variables/GREETING`,
      headers: auth(token),
      payload: { value: "v2-value" },
    });
    const v2Id = (await deploy(token, instanceId, DIGEST_2)).json().id as string;
    await db.update(deployments).set({ status: "Superseded" }).where(sql`id = ${v1Id}`);
    await db.update(deployments).set({ status: "Running" }).where(sql`id = ${v2Id}`);

    const res = await rollback(token, v1Id);

    expect(res.statusCode).toBe(202);
    const v3 = res.json();
    expect(v3).toMatchObject({
      versionNo: 3,
      status: "Queued",
      trigger: "rollback",
      imageDigest: DIGEST,
      rollbackOfId: v1Id,
    });
    const [v3Row] = await db.select().from(deployments).where(sql`id = ${v3.id}`);
    // Same snapshot id as v1 (reused, not a fresh one resolved from the now-different current env).
    expect(v3Row.envSnapshotId).toBe(v1.envSnapshotId);
    expect(await db.select().from(envSnapshots)).toHaveLength(2); // v1's and v2's; none created for the rollback
    expect(queue.calls).toContainEqual({ serviceInstanceId: instanceId, versionNo: 3 });
  });

  it("records an audit log entry for the rollback", async () => {
    const { token, instanceId } = await setupInstance();
    const id = (await deploy(token, instanceId, DIGEST)).json().id as string;
    await db.update(deployments).set({ status: "Running" }).where(sql`id = ${id}`);

    const res = await rollback(token, id);

    const [log] = await db.select().from(auditLogs).where(sql`target = ${`deployment:${res.json().id}`}`);
    expect(log).toMatchObject({ action: "deployment.rollback" });
  });

  it("a nonexistent deployment id returns 404", async () => {
    const { token } = await setupInstance();

    const res = await rollback(token, "00000000-0000-0000-0000-000000000000");

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("deployment_not_found");
  });

  it("someone without access gets the same 404 as a nonexistent id", async () => {
    const owner = await setupInstance();
    const id = (await deploy(owner.token, owner.instanceId, DIGEST)).json().id as string;
    await db.update(deployments).set({ status: "Running" }).where(sql`id = ${id}`);
    const outsider = await createUserWithToken(db);

    const res = await rollback(outsider.token, id);

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("deployment_not_found");
  });

  it("a viewer cannot roll back", async () => {
    const { token, orgId, instanceId } = await setupInstance();
    const id = (await deploy(token, instanceId, DIGEST)).json().id as string;
    await db.update(deployments).set({ status: "Running" }).where(sql`id = ${id}`);
    await db.update(memberships).set({ role: "viewer" }).where(sql`organization_id = ${orgId}`);

    const res = await rollback(token, id);

    expect(res.statusCode).toBe(403);
  });

  it("cannot roll back to a version that never ran (still Queued)", async () => {
    const { token, instanceId } = await setupInstance();
    const id = (await deploy(token, instanceId, DIGEST)).json().id as string;

    const res = await rollback(token, id);

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("not_rollback_target");
  });

  it("fails to enqueue: responds 503 and marks the rollback deployment as Failed", async () => {
    const { token, instanceId } = await setupInstance();
    const id = (await deploy(token, instanceId, DIGEST)).json().id as string;
    await db.update(deployments).set({ status: "Running" }).where(sql`id = ${id}`);
    queue.fail = true;

    const res = await rollback(token, id);

    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("queue_unavailable");
    const rows = await db.select().from(deployments).where(sql`version_no = 2`);
    expect(rows[0].status).toBe("Failed");
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

describe("SSE log tailing", () => {
  it("stream=build opens the SSE and sends the saved snapshot's lines, then closes", async () => {
    const { token, instanceId } = await setupInstance();
    const id = (await deploy(token, instanceId, DIGEST)).json().id as string;
    await db.insert(buildLogs).values({ deploymentId: id, content: "=== build ===\nok" });
    // Build already finished: the route sends what it has and closes, instead of waiting for more lines.
    await db.update(deployments).set({ status: "Running" }).where(sql`id = ${id}`);

    const res = await app.inject({ method: "GET", url: `/v1/deployments/${id}/logs?stream=build`, headers: auth(token) });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toBe("data: === build ===\n\ndata: ok\n\n");
  });

  it("stream=runtime opens the SSE and sends the runtime's tailLogs lines", async () => {
    const { token, instanceId } = await setupInstance();
    const id = (await deploy(token, instanceId, DIGEST)).json().id as string;
    runtime.logs.set(workloadName(instanceId), ["line a", "line b"]);

    const res = await app.inject({ method: "GET", url: `/v1/deployments/${id}/logs?stream=runtime`, headers: auth(token) });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toBe("data: line a\n\ndata: line b\n\n");
  });

  it("stream=runtime with no runtime configured on the API responds 503", async () => {
    const bareApp = buildApp(db, { keyring, queue });
    const { token, instanceId } = await setupInstance();
    const id = (await deploy(token, instanceId, DIGEST)).json().id as string;

    const res = await bareApp.inject({ method: "GET", url: `/v1/deployments/${id}/logs?stream=runtime`, headers: auth(token) });

    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("runtime_unavailable");
    await bareApp.close();
  });

  it("a nonexistent deployment returns 404 even with stream", async () => {
    const { token } = await setupInstance();

    const res = await app.inject({
      method: "GET",
      url: `/v1/deployments/00000000-0000-0000-0000-000000000000/logs?stream=build`,
      headers: auth(token),
    });

    expect(res.statusCode).toBe(404);
  });
});

describe("metrics", () => {
  it("returns the runtime snapshot (replicas, image and state)", async () => {
    const { token, instanceId } = await setupInstance();
    runtime.statuses.set(workloadName(instanceId), { image: DIGEST, replicas: 2, readyReplicas: 2 });

    const res = await app.inject({ method: "GET", url: `/v1/services/${instanceId}/metrics`, headers: auth(token) });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ instanceId, replicas: 2, readyReplicas: 2, image: DIGEST, status: "running" });
  });

  it("with no workload in the runtime, returns stopped state with zero replicas", async () => {
    const { token, instanceId } = await setupInstance();

    const res = await app.inject({ method: "GET", url: `/v1/services/${instanceId}/metrics`, headers: auth(token) });

    expect(res.json()).toEqual({ instanceId, replicas: 0, readyReplicas: 0, image: null, status: "stopped" });
  });

  it("whoever has no access to the instance gets 404", async () => {
    const owner = await setupInstance();
    const outsider = await createUserWithToken(db);

    const res = await app.inject({
      method: "GET",
      url: `/v1/services/${owner.instanceId}/metrics`,
      headers: auth(outsider.token),
    });

    expect(res.statusCode).toBe(404);
  });
});
