import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { testKeyring } from "./crypto/testing.js";
import { db } from "./db/client.js";
import { createUserWithToken } from "./db/fixtures.js";

// Low, explicitly-injected limits (via buildApp's `rateLimit` option) instead of the real
// defaults (300/min, 10/min for login) - this proves the behavior without hundreds of real calls.
const GENERAL_MAX = 3;
const LOGIN_MAX = 2;

const app = buildApp(db, {
  keyring: testKeyring(),
  rateLimit: {
    max: GENERAL_MAX,
    windowMs: 60_000,
    login: { max: LOGIN_MAX, windowMs: 60_000 },
  },
});

beforeEach(async () => {
  const { rows } = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public' and tablename not in ('__drizzle_migrations', 'regions')`,
  );
  await db.execute(sql.raw(`truncate ${rows.map((r) => `"${r.tablename}"`).join(", ")} restart identity cascade`));
});

afterAll(async () => {
  await app.close();
});

function authed(token: string) {
  return { authorization: `Bearer ${token}` };
}

function uniqueEmail(label: string): string {
  return `${label}-${randomBytes(4).toString("hex")}@example.com`;
}

describe("per-user rate limiting", () => {
  it("allows up to the configured max requests per user and then returns 429 problem+json", async () => {
    const { token } = await createUserWithToken(db, "rate-general");

    for (let i = 0; i < GENERAL_MAX; i++) {
      const res = await app.inject({ method: "GET", url: "/v1/organizations", headers: authed(token) });
      expect(res.statusCode).toBe(200);
    }

    const blocked = await app.inject({ method: "GET", url: "/v1/organizations", headers: authed(token) });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["content-type"]).toContain("application/problem+json");
    expect(blocked.json().code).toBe("rate_limited");
  });

  it("keys the limit by userId, so a different user has an independent budget", async () => {
    const { token: tokenA } = await createUserWithToken(db, "rate-a");
    const { token: tokenB } = await createUserWithToken(db, "rate-b");

    for (let i = 0; i < GENERAL_MAX; i++) {
      const res = await app.inject({ method: "GET", url: "/v1/organizations", headers: authed(tokenA) });
      expect(res.statusCode).toBe(200);
    }
    // User A is now at its limit, but user B's bucket is untouched.
    const blockedA = await app.inject({ method: "GET", url: "/v1/organizations", headers: authed(tokenA) });
    expect(blockedA.statusCode).toBe(429);

    const okB = await app.inject({ method: "GET", url: "/v1/organizations", headers: authed(tokenB) });
    expect(okB.statusCode).toBe(200);
  });
});

describe("login rate limiting", () => {
  it("limits POST /v1/auth/login by IP (no userId exists yet) with its own, tighter budget", async () => {
    // No account exists for these emails, so each attempt is 401 — the rate limiter counts
    // requests regardless of outcome, which is the point: it still kicks in before any user lookup.
    for (let i = 0; i < LOGIN_MAX; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email: uniqueEmail("login-rl"), password: "wrong-password" },
      });
      expect(res.statusCode).toBe(401);
    }

    const blocked = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: uniqueEmail("login-rl"), password: "wrong-password" },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["content-type"]).toContain("application/problem+json");
    expect(blocked.json().code).toBe("rate_limited");
  });
});
