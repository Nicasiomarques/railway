import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { testKeyring } from "./crypto/testing.js";
import { db } from "./db/client.js";
import { createUserWithToken } from "./db/fixtures.js";
import { memberships } from "./db/schema.js";

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

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function setup() {
  const { token, org } = await createUserWithToken(db);
  const project = (
    await app.inject({ method: "POST", url: "/v1/projects", headers: auth(token), payload: { organizationId: org.id, name: "Web" } })
  ).json();
  const create = (name: string, kind: string) =>
    app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/services`,
      headers: auth(token),
      payload: { name, kind, source: "template" },
    });
  await create("api", "web");
  await create("db", "postgres");
  const list = (
    await app.inject({ method: "GET", url: `/v1/projects/${project.id}/services`, headers: auth(token) })
  ).json().data as { name: string; instances: { id: string; environmentName: string }[] }[];
  const instanceOf = (name: string) => list.find((s) => s.name === name)!.instances[0].id;
  return { token, projectId: project.id as string, orgId: org.id, api: instanceOf("api"), db: instanceOf("db") };
}

describe("conexões", () => {
  it("cria conexão entre instâncias do mesmo ambiente e lista", async () => {
    const { token, projectId, api: a, db: b } = await setup();
    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/connections`,
      headers: auth(token),
      payload: { fromInstanceId: a, toInstanceId: b },
    });
    expect(res.statusCode).toBe(201);

    const list = await app.inject({ method: "GET", url: `/v1/projects/${projectId}/connections`, headers: auth(token) });
    expect(list.json().data).toEqual([
      expect.objectContaining({ fromInstanceId: a, toInstanceId: b, environmentName: "production" }),
    ]);
  });

  it("repetir a mesma conexão não duplica", async () => {
    const { token, projectId, api: a, db: b } = await setup();
    const payload = { fromInstanceId: a, toInstanceId: b };
    await app.inject({ method: "POST", url: `/v1/projects/${projectId}/connections`, headers: auth(token), payload });
    const again = await app.inject({ method: "POST", url: `/v1/projects/${projectId}/connections`, headers: auth(token), payload });
    expect(again.statusCode).toBe(201);

    const list = await app.inject({ method: "GET", url: `/v1/projects/${projectId}/connections`, headers: auth(token) });
    expect(list.json().data).toHaveLength(1);
  });

  it("rejeita conexão de um serviço consigo mesmo", async () => {
    const { token, projectId, api: a } = await setup();
    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/connections`,
      headers: auth(token),
      payload: { fromInstanceId: a, toInstanceId: a },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("invalid_connection");
  });

  it("rejeita instâncias de ambientes diferentes", async () => {
    const { token, projectId, api: a } = await setup();
    await db.execute(sql`insert into environments (project_id, name, type) values (${projectId}, 'staging', 'staging')`);
    const stagingInstance = await db.execute<{ id: string }>(sql`
      insert into service_instances (service_id, environment_id)
      select s.id, e.id from services s, environments e
      where s.name = 'db' and s.project_id = ${projectId} and e.name = 'staging'
      returning id`);
    const stagingId = stagingInstance.rows[0].id;

    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/connections`,
      headers: auth(token),
      payload: { fromInstanceId: a, toInstanceId: stagingId },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain("mesmo ambiente");
  });

  it("rejeita instância de outro projeto", async () => {
    const { token, projectId, api: a } = await setup();
    const outsider = await setup();
    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/connections`,
      headers: auth(token),
      payload: { fromInstanceId: a, toInstanceId: outsider.api },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("instance_not_found");
  });

  it("impede viewer de criar e remover conexões", async () => {
    const { token, projectId, orgId, api: a, db: b } = await setup();
    await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/connections`,
      headers: auth(token),
      payload: { fromInstanceId: a, toInstanceId: b },
    });

    const viewer = await createUserWithToken(db, "viewer");
    await db.insert(memberships).values({ organizationId: orgId, userId: viewer.user.id, role: "viewer" });

    const create = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/connections`,
      headers: auth(viewer.token),
      payload: { fromInstanceId: b, toInstanceId: a },
    });
    expect(create.statusCode).toBe(403);

    const remove = await app.inject({
      method: "DELETE",
      url: `/v1/projects/${projectId}/connections?fromInstanceId=${a}&toInstanceId=${b}`,
      headers: auth(viewer.token),
    });
    expect(remove.statusCode).toBe(403);
  });

  it("remove conexão e retorna 404 quando ela não existe", async () => {
    const { token, projectId, api: a, db: b } = await setup();
    await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/connections`,
      headers: auth(token),
      payload: { fromInstanceId: a, toInstanceId: b },
    });
    const url = `/v1/projects/${projectId}/connections?fromInstanceId=${a}&toInstanceId=${b}`;

    const first = await app.inject({ method: "DELETE", url, headers: auth(token) });
    expect(first.statusCode).toBe(204);

    const second = await app.inject({ method: "DELETE", url, headers: auth(token) });
    expect(second.statusCode).toBe(404);
    expect(second.json().code).toBe("connection_not_found");
  });
});
