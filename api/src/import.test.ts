import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { testKeyring } from "./crypto/testing.js";
import { db } from "./db/client.js";
import { createUserWithToken } from "./db/fixtures.js";

const app = buildApp(db, { keyring: testKeyring() });

beforeEach(async () => {
  const { rows } = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public' and tablename <> '__drizzle_migrations'`,
  );
  await db.execute(sql.raw(`truncate ${rows.map((r) => `"${r.tablename}"`).join(", ")} restart identity cascade`));
});

afterAll(async () => {
  await app.close();
});

const auth = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });

async function setupProject() {
  const { token, org } = await createUserWithToken(db);
  const res = await app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: auth(token),
    payload: { organizationId: org.id, name: "Web" },
  });
  return { token, projectId: res.json().id as string };
}

describe("import", () => {
  it("imports a Heroku app.json's formation as one service per process type", async () => {
    const { token, projectId } = await setupProject();
    const manifest = JSON.stringify({
      repository: "https://github.com/acme/api.git",
      env: { NODE_ENV: { value: "production" }, SECRET_KEY: { required: true } },
      formation: { web: { quantity: 1 }, worker: { quantity: 1 }, clock: { quantity: 0 } },
    });
    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/import`,
      headers: auth(token),
      payload: { provider: "heroku", manifest },
    });
    expect(res.statusCode).toBe(201);
    const names = res.json().data.map((s: { name: string }) => s.name).sort();
    expect(names).toEqual(["web", "worker"]);

    const list = await app.inject({ method: "GET", url: `/v1/projects/${projectId}/services`, headers: auth(token) });
    expect(list.json().data).toHaveLength(2);

    const web = res.json().data.find((s: { name: string }) => s.name === "web");
    const env = await app.inject({
      method: "GET",
      url: `/v1/services/${web.instances[0].id}/env`,
      headers: auth(token),
    });
    const nodeEnv = env.json().data.find((v: { key: string }) => v.key === "NODE_ENV");
    expect(nodeEnv.value).toBe("production");
    expect(env.json().data.find((v: { key: string }) => v.key === "SECRET_KEY")).toBeUndefined();
  });

  it("imports a Render render.yaml's services, including a cron job's schedule", async () => {
    const { token, projectId } = await setupProject();
    const manifest = [
      "services:",
      "  - type: web",
      "    name: api",
      "    repo: https://github.com/acme/api",
      "    envVars:",
      "      - key: NODE_ENV",
      "        value: production",
      "      - key: SECRET",
      "        sync: false",
      "  - type: cron",
      "    name: nightly-report",
      "    schedule: \"0 3 * * *\"",
    ].join("\n");
    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/import`,
      headers: auth(token),
      payload: { provider: "render", manifest },
    });
    expect(res.statusCode).toBe(201);
    const cron = res.json().data.find((s: { name: string }) => s.name === "nightly-report");
    expect(cron.kind).toBe("cron");
    const list = await app.inject({ method: "GET", url: `/v1/projects/${projectId}/services`, headers: auth(token) });
    const cronListed = list.json().data.find((s: { name: string }) => s.name === "nightly-report");
    expect(cronListed.instances[0].schedule).toBe("0 3 * * *");
  });

  it("rejects a Render cron service with no schedule", async () => {
    const { token, projectId } = await setupProject();
    const manifest = ["services:", "  - type: cron", "    name: nightly-report"].join("\n");
    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/import`,
      headers: auth(token),
      payload: { provider: "render", manifest },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("invalid_manifest");
  });

  it("imports a generic Railway-shaped manifest", async () => {
    const { token, projectId } = await setupProject();
    const manifest = JSON.stringify({
      services: [{ name: "api", kind: "web", repoUrl: "https://github.com/acme/api.git", variables: { PORT: "3000" } }],
    });
    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/import`,
      headers: auth(token),
      payload: { provider: "railway", manifest },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data[0].name).toBe("api");
    expect(res.json().data[0].source).toBe("github_repo");
  });

  it("rejects malformed JSON with 400 instead of 500", async () => {
    const { token, projectId } = await setupProject();
    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/import`,
      headers: auth(token),
      payload: { provider: "heroku", manifest: "{not json" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("invalid_manifest");
  });

  it("imports nothing when a later service's name collides, leaving the project untouched", async () => {
    const { token, projectId } = await setupProject();
    await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/services`,
      headers: auth(token),
      payload: { name: "worker", kind: "worker", source: "image" },
    });
    const manifest = JSON.stringify({ formation: { web: { quantity: 1 }, worker: { quantity: 1 } } });
    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/import`,
      headers: auth(token),
      payload: { provider: "heroku", manifest },
    });
    expect(res.statusCode).toBe(409);

    const list = await app.inject({ method: "GET", url: `/v1/projects/${projectId}/services`, headers: auth(token) });
    expect(list.json().data).toHaveLength(1);
  });

  it("prevents a viewer from importing", async () => {
    const { token: ownerToken, projectId } = await setupProject();
    const viewer = await createUserWithToken(db, "viewer");
    const orgRes = await app.inject({ method: "GET", url: "/v1/organizations", headers: auth(ownerToken) });
    const orgId = orgRes.json().data[0].id;
    await db.execute(sql`insert into memberships (organization_id, user_id, role) values (${orgId}, ${viewer.user.id}, 'viewer')`);

    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/import`,
      headers: auth(viewer.token),
      payload: { provider: "heroku", manifest: JSON.stringify({ formation: { web: { quantity: 1 } } }) },
    });
    expect(res.statusCode).toBe(403);
  });
});
