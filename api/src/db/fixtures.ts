import { randomBytes } from "node:crypto";
import { hashToken } from "../auth.js";
import type { Db } from "./client.js";
import { apiTokens, memberships, organizations, users } from "./schema.js";

// Creates a user, an organization (owner) and an API token. Used in the dev seed and in tests.
export async function createUserWithToken(db: Db, label = "dev") {
  const suffix = randomBytes(4).toString("hex");

  const [user] = await db
    .insert(users)
    .values({ externalId: `${label}|${suffix}`, email: `${label}-${suffix}@localhost` })
    .returning();

  const [org] = await db
    .insert(organizations)
    .values({ name: `Org ${label} ${suffix}`, slug: `org-${label}-${suffix}` })
    .returning();

  await db.insert(memberships).values({ organizationId: org.id, userId: user.id, role: "owner" });

  const token = `rl_${label}_${randomBytes(24).toString("base64url")}`;
  await db.insert(apiTokens).values({
    organizationId: org.id,
    userId: user.id,
    name: label,
    tokenHash: hashToken(token),
    scopes: ["*"],
  });

  return { user, org, token };
}
