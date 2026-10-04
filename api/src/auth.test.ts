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

function login(email: string) {
  return app.inject({ method: "POST", url: "/v1/auth/login", payload: { email } });
}

describe("POST /v1/auth/login", () => {
  it("creates a user on first login and returns a token that authenticates", async () => {
    const email = uniqueEmail("new-user");
    const res = await login(email);
    expect(res.statusCode).toBe(200);
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

  it("does not duplicate the user when logging in again with the same email", async () => {
    const email = uniqueEmail("repeat");
    const first = await login(email);
    const second = await login(email);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().userId).toBe(first.json().userId);

    const rows = await db.select().from(users).where(eq(users.email, email));
    expect(rows).toHaveLength(1);
  });

  it("never returns the same value as the hash stored for the token", async () => {
    const email = uniqueEmail("hash-check");
    const res = await login(email);
    const { token, userId } = res.json();

    const [row] = await db.select({ tokenHash: apiTokens.tokenHash }).from(apiTokens).where(eq(apiTokens.userId, userId));
    expect(row.tokenHash).toBeDefined();
    expect(row.tokenHash).not.toBe(token);
    expect(row.tokenHash).toBe(hashToken(token));
  });
});
