import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { db } from "./db/client.js";
import { createUserWithToken } from "./db/fixtures.js";
import { memberships } from "./db/schema.js";
import { testKeyring } from "./crypto/testing.js";
import type { BackupQueue } from "./queue.js";

function fakeBackupQueue() {
  const calls: { volumeId: string }[] = [];
  const restoreCalls: { volumeId: string }[] = [];
  const queue: BackupQueue = {
    async enqueueRunBackup(data) {
      calls.push(data);
    },
    async enqueueRestoreBackup(data) {
      restoreCalls.push(data);
    },
  };
  return { queue, calls, restoreCalls };
}

const { queue: backupQueue, calls: backupCalls, restoreCalls } = fakeBackupQueue();
const app = buildApp(db, { keyring: testKeyring(), backupQueue });

beforeEach(async () => {
  backupCalls.length = 0;
  restoreCalls.length = 0;
  const { rows } = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public' and tablename not in ('__drizzle_migrations', 'regions')`,
  );
  await db.execute(sql.raw(`truncate ${rows.map((r) => `"${r.tablename}"`).join(", ")} restart identity cascade`));
});

afterAll(async () => {
  await app.close();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function setup() {
  const { token, org } = await createUserWithToken(db);
  const project = (
    await app.inject({ method: "POST", url: "/v1/projects", headers: auth(token), payload: { organizationId: org.id, name: "Data" } })
  ).json();
  await app.inject({
    method: "POST",
    url: `/v1/projects/${project.id}/services`,
    headers: auth(token),
    payload: { name: "db", kind: "postgres", source: "postgres_template" },
  });
  const list = (
    await app.inject({ method: "GET", url: `/v1/projects/${project.id}/services`, headers: auth(token) })
  ).json().data as { instances: { id: string }[] }[];
  return { token, orgId: org.id as string, instanceId: list[0].instances[0].id as string };
}

async function createVolume(token: string, instanceId: string, payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: `/v1/services/${instanceId}/volumes`, headers: auth(token), payload });
}

describe("services accept postgres_template/redis_template as source", () => {
  it("creates a postgres_template service without a repoUrl", async () => {
    const { token, org } = await createUserWithToken(db);
    const project = (
      await app.inject({ method: "POST", url: "/v1/projects", headers: auth(token), payload: { organizationId: org.id, name: "Web" } })
    ).json();

    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/services`,
      headers: auth(token),
      payload: { name: "cache", kind: "redis", source: "redis_template" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().source).toBe("redis_template");
  });
});

describe("volumes", () => {
  it("creates a volume with backup_state none", async () => {
    const { token, instanceId } = await setup();
    const res = await createVolume(token, instanceId, { mountPath: "/var/lib/postgresql/data", sizeGb: 10 });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.mountPath).toBe("/var/lib/postgresql/data");
    expect(body.sizeGb).toBe(10);
    expect(body.backupState).toBe("none");
    expect(body.lastBackupAt).toBeNull();
  });

  it("rejects a mountPath that isn't absolute or that escapes with ..", async () => {
    const { token, instanceId } = await setup();

    const relative = await createVolume(token, instanceId, { mountPath: "data", sizeGb: 10 });
    expect(relative.statusCode).toBe(400);

    const traversal = await createVolume(token, instanceId, { mountPath: "/data/../etc", sizeGb: 10 });
    expect(traversal.statusCode).toBe(400);
  });

  it("rejects a non-positive or oversized sizeGb", async () => {
    const { token, instanceId } = await setup();

    const zero = await createVolume(token, instanceId, { mountPath: "/data", sizeGb: 0 });
    expect(zero.statusCode).toBe(400);

    const huge = await createVolume(token, instanceId, { mountPath: "/data", sizeGb: 100_000 });
    expect(huge.statusCode).toBe(400);
  });

  it("lists the instance's volumes", async () => {
    const { token, instanceId } = await setup();
    await createVolume(token, instanceId, { mountPath: "/data", sizeGb: 5 });
    await createVolume(token, instanceId, { mountPath: "/other", sizeGb: 20 });

    const list = await app.inject({ method: "GET", url: `/v1/services/${instanceId}/volumes`, headers: auth(token) });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveLength(2);
  });

  it("blocks a viewer from creating a volume, but allows listing", async () => {
    const { token, orgId, instanceId } = await setup();
    const viewer = await createUserWithToken(db, "viewer");
    await db.insert(memberships).values({ organizationId: orgId, userId: viewer.user.id, role: "viewer" });

    const create = await createVolume(viewer.token, instanceId, { mountPath: "/data", sizeGb: 5 });
    expect(create.statusCode).toBe(403);

    const list = await app.inject({ method: "GET", url: `/v1/services/${instanceId}/volumes`, headers: auth(viewer.token) });
    expect(list.statusCode).toBe(200);
  });

  it("returns 404 for an instance in another organization", async () => {
    const { instanceId } = await setup();
    const outsider = await createUserWithToken(db, "outsider");
    const res = await app.inject({ method: "GET", url: `/v1/services/${instanceId}/volumes`, headers: auth(outsider.token) });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("instance_not_found");
  });

  it("writes an audit log entry on creation", async () => {
    const { token, orgId, instanceId } = await setup();
    await createVolume(token, instanceId, { mountPath: "/data", sizeGb: 5 });

    const { rows } = await db.execute<{ organization_id: string; metadata: unknown }>(
      sql`select organization_id, metadata from audit_logs where action = 'volume.create'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].organization_id).toBe(orgId);
    expect(JSON.stringify(rows[0].metadata)).toContain("/data");
  });
});

describe("triggering a backup", () => {
  async function createdVolumeId(token: string, instanceId: string): Promise<string> {
    const res = await createVolume(token, instanceId, { mountPath: "/data", sizeGb: 5 });
    return res.json().id;
  }

  it("enqueues a run-backup job and returns 202 with the volume", async () => {
    const { token, instanceId } = await setup();
    const volumeId = await createdVolumeId(token, instanceId);

    const res = await app.inject({ method: "POST", url: `/v1/volumes/${volumeId}/backup`, headers: auth(token) });

    expect(res.statusCode).toBe(202);
    expect(res.json().id).toBe(volumeId);
    expect(backupCalls).toEqual([{ volumeId }]);
  });

  it("returns 404 for a volume that doesn't exist", async () => {
    const { token } = await setup();
    const res = await app.inject({
      method: "POST",
      url: `/v1/volumes/00000000-0000-0000-0000-000000000000/backup`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("volume_not_found");
  });

  it("blocks a viewer from triggering a backup", async () => {
    const { token, orgId, instanceId } = await setup();
    const volumeId = await createdVolumeId(token, instanceId);
    const viewer = await createUserWithToken(db, "viewer");
    await db.insert(memberships).values({ organizationId: orgId, userId: viewer.user.id, role: "viewer" });

    const res = await app.inject({ method: "POST", url: `/v1/volumes/${volumeId}/backup`, headers: auth(viewer.token) });
    expect(res.statusCode).toBe(403);
  });

  it("returns 404 (not the other org's details) for a volume owned by another organization", async () => {
    const { token, instanceId } = await setup();
    const volumeId = await createdVolumeId(token, instanceId);
    const outsider = await createUserWithToken(db, "outsider");

    const res = await app.inject({ method: "POST", url: `/v1/volumes/${volumeId}/backup`, headers: auth(outsider.token) });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("volume_not_found");
  });

  it("writes an audit log entry when a backup is triggered", async () => {
    const { token, orgId, instanceId } = await setup();
    const volumeId = await createdVolumeId(token, instanceId);

    await app.inject({ method: "POST", url: `/v1/volumes/${volumeId}/backup`, headers: auth(token) });

    const { rows } = await db.execute<{ organization_id: string; target: string }>(
      sql`select organization_id, target from audit_logs where action = 'volume.backup_triggered'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].organization_id).toBe(orgId);
    expect(rows[0].target).toBe(`volume:${volumeId}`);
  });
});

// Phase 3 (docs/roadmap.md) "Backup restore testing": the route side of restore existed nowhere
// before this — just the provider method. See docs/runbooks/backup-restore.md for when to call this.
describe("triggering a restore", () => {
  async function createdVolumeId(token: string, instanceId: string): Promise<string> {
    const res = await createVolume(token, instanceId, { mountPath: "/data", sizeGb: 5 });
    return res.json().id;
  }

  it("enqueues a restore-backup job and returns 202 with the volume", async () => {
    const { token, instanceId } = await setup();
    const volumeId = await createdVolumeId(token, instanceId);

    const res = await app.inject({ method: "POST", url: `/v1/volumes/${volumeId}/restore`, headers: auth(token) });

    expect(res.statusCode).toBe(202);
    expect(res.json().id).toBe(volumeId);
    expect(restoreCalls).toEqual([{ volumeId }]);
  });

  it("returns 404 for a volume that doesn't exist", async () => {
    const { token } = await setup();
    const res = await app.inject({
      method: "POST",
      url: `/v1/volumes/00000000-0000-0000-0000-000000000000/restore`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("volume_not_found");
  });

  it("blocks a viewer from triggering a restore", async () => {
    const { token, orgId, instanceId } = await setup();
    const volumeId = await createdVolumeId(token, instanceId);
    const viewer = await createUserWithToken(db, "viewer");
    await db.insert(memberships).values({ organizationId: orgId, userId: viewer.user.id, role: "viewer" });

    const res = await app.inject({ method: "POST", url: `/v1/volumes/${volumeId}/restore`, headers: auth(viewer.token) });
    expect(res.statusCode).toBe(403);
  });

  it("returns 404 (not the other org's details) for a volume owned by another organization", async () => {
    const { token, instanceId } = await setup();
    const volumeId = await createdVolumeId(token, instanceId);
    const outsider = await createUserWithToken(db, "outsider");

    const res = await app.inject({ method: "POST", url: `/v1/volumes/${volumeId}/restore`, headers: auth(outsider.token) });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("volume_not_found");
  });

  it("writes an audit log entry when a restore is triggered", async () => {
    const { token, orgId, instanceId } = await setup();
    const volumeId = await createdVolumeId(token, instanceId);

    await app.inject({ method: "POST", url: `/v1/volumes/${volumeId}/restore`, headers: auth(token) });

    const { rows } = await db.execute<{ organization_id: string; target: string }>(
      sql`select organization_id, target from audit_logs where action = 'volume.restore_triggered'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].organization_id).toBe(orgId);
    expect(rows[0].target).toBe(`volume:${volumeId}`);
  });
});
