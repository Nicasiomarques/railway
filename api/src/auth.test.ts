import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { hashToken } from "./auth.js";
import { testKeyring } from "./crypto/testing.js";
import { db } from "./db/client.js";
import { apiTokens, users } from "./db/schema.js";

const app = buildApp(db, { keyring: testKeyring() });

beforeEach(async () => {
  const { rows } = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public' and tablename not in ('__drizzle_migrations', 'regions')`,
  );
  await db.execute(sql.raw(`truncate ${rows.map((r) => `"${r.tablename}"`).join(", ")} restart identity cascade`));
});

afterAll(async () => {
  await app.close();
});

function uniqueEmail(label: string): string {
  return `${label}-${randomBytes(4).toString("hex")}@example.com`;
}

function register(email: string, password = "correct-password") {
  return app.inject({ method: "POST", url: "/v1/auth/register", payload: { email, password } });
}

function login(email: string, password: string) {
  return app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
}

describe("POST /v1/auth/register", () => {
  it("creates a user with a password and returns a token that authenticates", async () => {
    const email = uniqueEmail("new-user");
    const res = await register(email);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.token).toBeTypeOf("string");
    expect(body.userId).toBeTypeOf("string");

    const authed = await app.inject({
      method: "GET",
      url: "/v1/organizations",
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(authed.statusCode).toBe(200);
  });

  it("never returns the same value as the hash stored for the token", async () => {
    const email = uniqueEmail("hash-check");
    const res = await register(email);
    const { token, userId } = res.json();

    const rows = await db.select({ tokenHash: apiTokens.tokenHash }).from(apiTokens).where(eq(apiTokens.userId, userId));
    expect(rows.map((r) => r.tokenHash)).toContain(hashToken(token));
    expect(rows.map((r) => r.tokenHash)).not.toContain(token);
  });

  it("never stores the password itself", async () => {
    const email = uniqueEmail("no-plaintext");
    await register(email, "correct-password");

    const [row] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.email, email));
    expect(row.passwordHash).toBeDefined();
    expect(row.passwordHash).not.toBe("correct-password");
    expect(row.passwordHash).not.toContain("correct-password");
  });

  it("rejects a second registration with the same email", async () => {
    const email = uniqueEmail("taken");
    const first = await register(email);
    expect(first.statusCode).toBe(201);

    const second = await register(email);
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("email_taken");

    const rows = await db.select().from(users).where(eq(users.email, email));
    expect(rows).toHaveLength(1);
  });

  it("rejects a password shorter than 8 characters", async () => {
    const res = await register(uniqueEmail("short-pw"), "short");
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /v1/auth/login", () => {
  it("logs in with the correct email and password", async () => {
    const email = uniqueEmail("login-ok");
    const { userId } = (await register(email, "correct-password")).json();

    const res = await login(email, "correct-password");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.userId).toBe(userId);
    expect(body.token).toBeTypeOf("string");

    const authed = await app.inject({
      method: "GET",
      url: "/v1/organizations",
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(authed.statusCode).toBe(200);
  });

  it("reuses the same user and organization across logins", async () => {
    const email = uniqueEmail("repeat");
    const { userId: registeredId } = (await register(email, "correct-password")).json();

    const first = await login(email, "correct-password");
    const second = await login(email, "correct-password");

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json().userId).toBe(registeredId);
    expect(second.json().userId).toBe(registeredId);

    const rows = await db.select().from(users).where(eq(users.email, email));
    expect(rows).toHaveLength(1);
  });

  it("rejects a wrong password", async () => {
    const email = uniqueEmail("wrong-pw");
    await register(email, "correct-password");

    const res = await login(email, "not-the-password");
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("invalid_credentials");
  });

  it("rejects an email that was never registered", async () => {
    const res = await login(uniqueEmail("never-registered"), "whatever-password");
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("invalid_credentials");
  });

  it("never returns the same value as the hash stored for the token", async () => {
    const email = uniqueEmail("hash-check-login");
    await register(email, "correct-password");
    const res = await login(email, "correct-password");
    const { token, userId } = res.json();

    const rows = await db.select({ tokenHash: apiTokens.tokenHash }).from(apiTokens).where(eq(apiTokens.userId, userId));
    expect(rows.map((r) => r.tokenHash)).toContain(hashToken(token));
    expect(rows.map((r) => r.tokenHash)).not.toContain(token);
  });
});
