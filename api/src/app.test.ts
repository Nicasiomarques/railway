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

describe("authentication", () => {
  it("rejects request without a token", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/organizations" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.json().code).toBe("unauthenticated");
  });

  it("rejects nonexistent token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/organizations",
      headers: authed("rl_dev_nope"),
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects expired token", async () => {
    const { user, token } = await createUserWithToken(db, "expired");
    await db
      .update(apiTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiTokens.userId, user.id));

    const res = await app.inject({ method: "GET", url: "/v1/organizations", headers: authed(token) });
    expect(res.statusCode).toBe(401);
  });
});

describe("organizations", () => {
  it("creates organization with slug derived from the name and the creator as owner", async () => {
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

  it("returns 409 for duplicate slug", async () => {
    const { token } = await createUserWithToken(db);
    const payload = { name: "Acme", slug: "acme" };
    await app.inject({ method: "POST", url: "/v1/organizations", headers: authed(token), payload });
    const res = await app.inject({ method: "POST", url: "/v1/organizations", headers: authed(token), payload });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("slug_taken");
  });

  it("returns 400 as problem+json for invalid body", async () => {
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
  it("repeating the same key and body returns the same response without creating another resource", async () => {
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

  it("returns 422 when the same key is used with a different body", async () => {
    const { token } = await createUserWithToken(db);
    const headers = authed(token, { "idempotency-key": "req-2" });
    await app.inject({ method: "POST", url: "/v1/organizations", headers, payload: { name: "Um" } });
    const res = await app.inject({ method: "POST", url: "/v1/organizations", headers, payload: { name: "Outro" } });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("idempotency_key_reused");
  });
});

describe("projects", () => {
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

  it("creates project inside an organization it is a member of", async () => {
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

  it("returns 404 for an organization the user is not a member of", async () => {
    const { orgId } = await setup();
    const outsider = await createUserWithToken(db, "outsider");
    const res = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: authed(outsider.token),
      payload: { organizationId: orgId, name: "Invasion" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("paginates by cursor without repeating or losing items", async () => {
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

  it("returns 400 for invalid cursor", async () => {
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
