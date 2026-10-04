import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_REGION_ID } from "@railway-like/db";
import { buildApp } from "./app.js";
import { testKeyring } from "./crypto/testing.js";
import { db } from "./db/client.js";
import { createUserWithToken } from "./db/fixtures.js";
import { regions } from "./db/schema.js";

const app = buildApp(db, { keyring: testKeyring() });
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeEach(async () => {
  const { rows } = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public' and tablename not in ('__drizzle_migrations', 'regions')`,
  );
  await db.execute(sql.raw(`truncate ${rows.map((r) => `"${r.tablename}"`).join(", ")} restart identity cascade`));
});

afterAll(async () => {
  await app.close();
});

describe("GET /v1/regions", () => {
  it("lists the seeded default region", async () => {
    const { token } = await createUserWithToken(db);

    const res = await app.inject({ method: "GET", url: "/v1/regions", headers: auth(token) });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual(expect.arrayContaining([{ id: DEFAULT_REGION_ID, slug: "default", name: "Default" }]));
  });
});

describe("POST /v1/projects regionId", () => {
  it("a project created with no regionId gets the default region", async () => {
    const { token, org } = await createUserWithToken(db);

    const res = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: auth(token),
      payload: { organizationId: org.id, name: "Web" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().regionId).toBe(DEFAULT_REGION_ID);
  });

  it("a project can be created in an explicit region", async () => {
    const { token, org } = await createUserWithToken(db);
    const [other] = await db.insert(regions).values({ slug: "eu-west", name: "EU West" }).returning();

    const res = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: auth(token),
      payload: { organizationId: org.id, name: "Web", regionId: other.id },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().regionId).toBe(other.id);
  });

  it("an unknown regionId returns 404", async () => {
    const { token, org } = await createUserWithToken(db);

    const res = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: auth(token),
      payload: { organizationId: org.id, name: "Web", regionId: "00000000-0000-0000-0000-000000000099" },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("region_not_found");
  });
});
