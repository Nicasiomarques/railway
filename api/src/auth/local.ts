import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { hashToken } from "../auth.js";
import { slugify } from "../slug.js";
import type { Db } from "../db/client.js";
import { apiTokens, memberships, organizations, users } from "../db/schema.js";
import type { AuthProvider, LoginCredentials, LoginResult } from "./provider.js";

// A token issued at login stays valid for 30 days; after that the client has to log in again.
// (`createUserWithToken` in db/fixtures.ts, used by `pnpm db:seed` and tests, leaves `expiresAt`
// null on purpose — dev/test tokens that never expire — so it is not reused here.)
const LOGIN_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Default (and, for now, only) `AuthProvider`: there is no external identity provider in the MVP
// (architecture.md §3), so "login" means "find or create the local `User` row for this email, then
// issue a fresh API token for it". This is the production version of what
// `db/fixtures.ts#createUserWithToken` already does for tests and `pnpm db:seed`.
export class LocalAuthProvider implements AuthProvider {
  constructor(private readonly db: Db) {}

  async login({ email }: LoginCredentials): Promise<LoginResult | null> {
    const normalized = email.trim().toLowerCase();
    if (!normalized) return null;

    return this.db.transaction(async (tx) => {
      let [user] = await tx.select().from(users).where(eq(users.email, normalized)).limit(1);
      if (!user) {
        [user] = await tx
          .insert(users)
          .values({ externalId: `local|${normalized}`, email: normalized })
          .returning();
      }

      // Reuse an organization the user already belongs to (oldest membership first), so that
      // logging in again doesn't spawn a new organization every time. Only a brand-new user (no
      // memberships yet) gets one created here, exactly like `createUserWithToken` does.
      const [existingMembership] = await tx
        .select({ organizationId: memberships.organizationId })
        .from(memberships)
        .where(eq(memberships.userId, user.id))
        .orderBy(memberships.createdAt)
        .limit(1);

      let organizationId = existingMembership?.organizationId;
      if (!organizationId) {
        const suffix = randomBytes(4).toString("hex");
        const namePart = normalized.split("@")[0] || "user";
        const [org] = await tx
          .insert(organizations)
          .values({ name: `${namePart}'s organization`, slug: `${slugify(namePart)}-${suffix}` })
          .returning();
        await tx.insert(memberships).values({ organizationId: org.id, userId: user.id, role: "owner" });
        organizationId = org.id;
      }

      const token = `rl_login_${randomBytes(24).toString("base64url")}`;
      await tx.insert(apiTokens).values({
        organizationId,
        userId: user.id,
        name: "login",
        tokenHash: hashToken(token),
        scopes: ["*"],
        expiresAt: new Date(Date.now() + LOGIN_TOKEN_TTL_MS),
      });

      return { userId: user.id, token };
    });
  }
}
