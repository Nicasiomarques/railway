import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { db } from "./db/client.js";
import { createUserWithToken } from "./db/fixtures.js";
import { memberships } from "./db/schema.js";
import { testKeyring } from "./crypto/testing.js";

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
  await app.inject({
    method: "POST",
    url: `/v1/projects/${project.id}/services`,
    headers: auth(token),
    payload: { name: "api", kind: "web", source: "github_repo", repoUrl: "https://github.com/acme/api.git" },
  });
  const list = (
    await app.inject({ method: "GET", url: `/v1/projects/${project.id}/services`, headers: auth(token) })
  ).json().data as { instances: { id: string }[] }[];
  return { token, orgId: org.id as string, instanceId: list[0].instances[0].id as string };
}

async function createDomain(token: string, instanceId: string, payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: `/v1/services/${instanceId}/domains`, headers: auth(token), payload });
}

describe("domínios", () => {
  it("cria domínio auto com subdomínio gerado e tls_state pending", async () => {
    const { token, instanceId } = await setup();
    const res = await createDomain(token, instanceId, { type: "auto" });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.type).toBe("auto");
    expect(body.tlsState).toBe("pending");
    expect(body.hostname).toMatch(/^api-[0-9a-f]{8}\.apps\.railway\.local$/);
  });

  it("cria domínio custom com o hostname informado", async () => {
    const { token, instanceId } = await setup();
    const res = await createDomain(token, instanceId, { type: "custom", hostname: "app.minhaempresa.com" });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual(
      expect.objectContaining({ type: "custom", hostname: "app.minhaempresa.com", tlsState: "pending" }),
    );
  });

  it("rejeita custom sem hostname e auto com hostname", async () => {
    const { token, instanceId } = await setup();

    const semHostname = await createDomain(token, instanceId, { type: "custom" });
    expect(semHostname.statusCode).toBe(400);

    const comHostname = await createDomain(token, instanceId, { type: "auto", hostname: "nao-deveria.com" });
    expect(comHostname.statusCode).toBe(400);
  });

  it("rejeita hostname com formato inválido", async () => {
    const { token, instanceId } = await setup();
    const res = await createDomain(token, instanceId, { type: "custom", hostname: "nao é um hostname" });
    expect(res.statusCode).toBe(400);
  });

  it("recusa hostname repetido, mesmo em instâncias diferentes", async () => {
    const { token, instanceId } = await setup();
    await createDomain(token, instanceId, { type: "custom", hostname: "duplicado.com" });

    const again = await createDomain(token, instanceId, { type: "custom", hostname: "duplicado.com" });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("hostname_taken");
  });

  it("lista os domínios da instância", async () => {
    const { token, instanceId } = await setup();
    await createDomain(token, instanceId, { type: "auto" });
    await createDomain(token, instanceId, { type: "custom", hostname: "outro.com" });

    const list = await app.inject({ method: "GET", url: `/v1/services/${instanceId}/domains`, headers: auth(token) });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveLength(2);
  });

  it("remove domínio e retorna 404 quando ele não existe", async () => {
    const { token, instanceId } = await setup();
    const created = (await createDomain(token, instanceId, { type: "custom", hostname: "apagar.com" })).json();

    const del = await app.inject({
      method: "DELETE",
      url: `/v1/services/${instanceId}/domains/${created.id}`,
      headers: auth(token),
    });
    expect(del.statusCode).toBe(204);

    const again = await app.inject({
      method: "DELETE",
      url: `/v1/services/${instanceId}/domains/${created.id}`,
      headers: auth(token),
    });
    expect(again.statusCode).toBe(404);
    expect(again.json().code).toBe("domain_not_found");
  });

  it("impede viewer de criar ou remover, mas permite listar", async () => {
    const { token, orgId, instanceId } = await setup();
    const created = (await createDomain(token, instanceId, { type: "custom", hostname: "viewer-test.com" })).json();
    const viewer = await createUserWithToken(db, "viewer");
    await db.insert(memberships).values({ organizationId: orgId, userId: viewer.user.id, role: "viewer" });

    const create = await createDomain(viewer.token, instanceId, { type: "custom", hostname: "viewer2.com" });
    expect(create.statusCode).toBe(403);

    const del = await app.inject({
      method: "DELETE",
      url: `/v1/services/${instanceId}/domains/${created.id}`,
      headers: auth(viewer.token),
    });
    expect(del.statusCode).toBe(403);

    const list = await app.inject({ method: "GET", url: `/v1/services/${instanceId}/domains`, headers: auth(viewer.token) });
    expect(list.statusCode).toBe(200);
  });

  it("retorna 404 para instância de outra organização", async () => {
    const { instanceId } = await setup();
    const outsider = await createUserWithToken(db, "outsider");
    const res = await app.inject({ method: "GET", url: `/v1/services/${instanceId}/domains`, headers: auth(outsider.token) });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("instance_not_found");
  });

  it("não grava valor no log de auditoria sem o hostname", async () => {
    const { token, orgId, instanceId } = await setup();
    await createDomain(token, instanceId, { type: "custom", hostname: "auditado.com" });

    const { rows } = await db.execute<{ organization_id: string; metadata: unknown }>(
      sql`select organization_id, metadata from audit_logs where action = 'domain.create'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].organization_id).toBe(orgId);
    expect(JSON.stringify(rows[0].metadata)).toContain("auditado.com");
  });
});
