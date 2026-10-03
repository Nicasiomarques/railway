import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { db } from "./db/client.js";
import { createUserWithToken } from "./db/fixtures.js";
import { memberships } from "./db/schema.js";

const app = buildApp(db);

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
  return { token, orgId: org.id, projectId: res.json().id as string };
}

describe("ambientes", () => {
  it("todo projeto nasce com o ambiente production", async () => {
    const { token, projectId } = await setupProject();
    const res = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/environments`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.map((e: { name: string }) => e.name)).toEqual(["production"]);
  });
});

describe("serviços", () => {
  it("cria o serviço com uma instância por ambiente", async () => {
    const { token, projectId } = await setupProject();
    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/services`,
      headers: auth(token),
      payload: { name: "api", kind: "web", source: "github_repo" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().rootDir).toBe("/");
    expect(res.json().instances).toHaveLength(1);

    const list = await app.inject({ method: "GET", url: `/v1/projects/${projectId}/services`, headers: auth(token) });
    const [svc] = list.json().data;
    expect(svc.name).toBe("api");
    expect(svc.instances[0].environmentName).toBe("production");
  });

  it("cria instâncias em todos os ambientes existentes ao criar o serviço", async () => {
    const { token, projectId } = await setupProject();
    await db.execute(sql`insert into environments (project_id, name, type) values (${projectId}, 'staging', 'staging')`);

    await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/services`,
      headers: auth(token),
      payload: { name: "api", kind: "web", source: "github_repo" },
    });
    const list = await app.inject({ method: "GET", url: `/v1/projects/${projectId}/services`, headers: auth(token) });
    const names = list.json().data[0].instances.map((i: { environmentName: string }) => i.environmentName).sort();
    expect(names).toEqual(["production", "staging"]);
  });

  it("retorna 409 para nome duplicado no mesmo projeto", async () => {
    const { token, projectId } = await setupProject();
    const payload = { name: "api", kind: "web", source: "github_repo" };
    await app.inject({ method: "POST", url: `/v1/projects/${projectId}/services`, headers: auth(token), payload });
    const res = await app.inject({ method: "POST", url: `/v1/projects/${projectId}/services`, headers: auth(token), payload });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("name_taken");
  });

  it("rejeita tipo de serviço desconhecido", async () => {
    const { token, projectId } = await setupProject();
    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/services`,
      headers: auth(token),
      payload: { name: "api", kind: "cron", source: "github_repo" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("validation_failed");
  });

  it("impede viewer de criar serviço, mas permite leitura", async () => {
    const { projectId, orgId } = await setupProject();
    const viewer = await createUserWithToken(db, "viewer");
    await db.insert(memberships).values({ organizationId: orgId, userId: viewer.user.id, role: "viewer" });

    const create = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/services`,
      headers: auth(viewer.token),
      payload: { name: "api", kind: "web", source: "github_repo" },
    });
    expect(create.statusCode).toBe(403);
    expect(create.json().code).toBe("forbidden");

    const read = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/services`,
      headers: auth(viewer.token),
    });
    expect(read.statusCode).toBe(200);
  });

  it("retorna 404 para projeto de outra organização", async () => {
    const { projectId } = await setupProject();
    const outsider = await createUserWithToken(db, "outsider");
    const res = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/services`,
      headers: auth(outsider.token),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("project_not_found");
  });

  it("repetir com a mesma Idempotency-Key não cria outro serviço", async () => {
    const { token, projectId } = await setupProject();
    const headers = auth(token, { "idempotency-key": "svc-1" });
    const payload = { name: "api", kind: "web", source: "github_repo" };
    const a = await app.inject({ method: "POST", url: `/v1/projects/${projectId}/services`, headers, payload });
    const b = await app.inject({ method: "POST", url: `/v1/projects/${projectId}/services`, headers, payload });
    expect(b.json().id).toBe(a.json().id);

    const list = await app.inject({ method: "GET", url: `/v1/projects/${projectId}/services`, headers: auth(token) });
    expect(list.json().data).toHaveLength(1);
  });
});
