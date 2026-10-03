import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { testKeyring } from "./crypto/testing.js";
import { db } from "./db/client.js";
import { createUserWithToken } from "./db/fixtures.js";
import { apiTokens } from "./db/schema.js";

const app = buildApp(db, { keyring: testKeyring() });

beforeEach(async () => {
  const { rows } = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public' and tablename <> '__drizzle_migrations'`,
  );
  const tables = rows.map((r) => `"${r.tablename}"`).join(", ");
  await db.execute(sql.raw(`truncate ${tables} restart identity cascade`));
});

afterAll(async () => {
  await app.close();
});

function authed(token: string, headers: Record<string, string> = {}) {
  return { authorization: `Bearer ${token}`, ...headers };
}

describe("autenticação", () => {
  it("rejeita requisição sem token", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/organizations" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.json().code).toBe("unauthenticated");
  });

  it("rejeita token inexistente", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/organizations",
      headers: authed("rl_dev_nope"),
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejeita token expirado", async () => {
    const { user, token } = await createUserWithToken(db, "expired");
    await db
      .update(apiTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiTokens.userId, user.id));

    const res = await app.inject({ method: "GET", url: "/v1/organizations", headers: authed(token) });
    expect(res.statusCode).toBe(401);
  });
});

describe("organizações", () => {
  it("cria organização com slug derivado do nome e o criador como owner", async () => {
    const { token } = await createUserWithToken(db);
    const res = await app.inject({
      method: "POST",
      url: "/v1/organizations",
      headers: authed(token),
      payload: { name: "Minha Empresa Ltda" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().slug).toBe("minha-empresa-ltda");

    const list = await app.inject({ method: "GET", url: "/v1/organizations", headers: authed(token) });
    const roles = list.json().data.map((o: { role: string }) => o.role);
    expect(roles).toContain("owner");
  });

  it("retorna 409 para slug duplicado", async () => {
    const { token } = await createUserWithToken(db);
    const payload = { name: "Acme", slug: "acme" };
    await app.inject({ method: "POST", url: "/v1/organizations", headers: authed(token), payload });
    const res = await app.inject({ method: "POST", url: "/v1/organizations", headers: authed(token), payload });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("slug_taken");
  });

  it("retorna 400 em problem+json para corpo inválido", async () => {
    const { token } = await createUserWithToken(db);
    const res = await app.inject({
      method: "POST",
      url: "/v1/organizations",
      headers: authed(token),
      payload: { name: "" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("validation_failed");
    expect(res.json().errors.length).toBeGreaterThan(0);
  });
});

describe("Idempotency-Key", () => {
  it("repetir a mesma chave e o mesmo corpo devolve a mesma resposta sem criar outro recurso", async () => {
    const { token } = await createUserWithToken(db);
    const headers = authed(token, { "idempotency-key": "req-1" });
    const payload = { name: "Idempotente" };

    const first = await app.inject({ method: "POST", url: "/v1/organizations", headers, payload });
    const second = await app.inject({ method: "POST", url: "/v1/organizations", headers, payload });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().id).toBe(first.json().id);

    const list = await app.inject({ method: "GET", url: "/v1/organizations", headers: authed(token) });
    const idempotente = list.json().data.filter((o: { slug: string }) => o.slug === "idempotente");
    expect(idempotente).toHaveLength(1);
  });

  it("retorna 422 quando a mesma chave é usada com outro corpo", async () => {
    const { token } = await createUserWithToken(db);
    const headers = authed(token, { "idempotency-key": "req-2" });
    await app.inject({ method: "POST", url: "/v1/organizations", headers, payload: { name: "Um" } });
    const res = await app.inject({ method: "POST", url: "/v1/organizations", headers, payload: { name: "Outro" } });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("idempotency_key_reused");
  });
});

describe("projetos", () => {
  async function setup() {
    const { token } = await createUserWithToken(db);
    const org = await app.inject({
      method: "POST",
      url: "/v1/organizations",
      headers: authed(token),
      payload: { name: "Time" },
    });
    return { token, orgId: org.json().id as string };
  }

  it("cria projeto dentro de uma organização da qual é membro", async () => {
    const { token, orgId } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: authed(token),
      payload: { organizationId: orgId, name: "API Principal" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().slug).toBe("api-principal");
  });

  it("retorna 404 para organização da qual o usuário não é membro", async () => {
    const { orgId } = await setup();
    const outsider = await createUserWithToken(db, "outsider");
    const res = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: authed(outsider.token),
      payload: { organizationId: orgId, name: "Invasão" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("pagina por cursor sem repetir nem perder itens", async () => {
    const { token, orgId } = await setup();
    for (let i = 1; i <= 5; i++) {
      await app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: authed(token),
        payload: { organizationId: orgId, name: `Projeto ${i}` },
      });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const qs = new URLSearchParams({ organizationId: orgId, limit: "2", ...(cursor ? { cursor } : {}) });
      const res = await app.inject({ method: "GET", url: `/v1/projects?${qs}`, headers: authed(token) });
      expect(res.statusCode).toBe(200);
      seen.push(...res.json().data.map((p: { id: string }) => p.id));
      cursor = res.json().nextCursor;
    } while (cursor);

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it("retorna 400 para cursor inválido", async () => {
    const { token, orgId } = await setup();
    const res = await app.inject({
      method: "GET",
      url: `/v1/projects?organizationId=${orgId}&cursor=lixo`,
      headers: authed(token),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("invalid_cursor");
  });
});
