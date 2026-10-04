import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { hashToken } from "../auth.js";
import { isUniqueViolation } from "../errors.js";
import { slugify } from "../slug.js";
import { hashPassword, verifyPassword } from "./password.js";
import type { Db } from "../db/client.js";
import { apiTokens, memberships, organizations, users } from "../db/schema.js";
import type { AuthProvider, LoginCredentials, LoginResult, RegisterCredentials } from "./provider.js";

// A token issued at login stays valid for 30 days; after that the client has to log in again.
// (`createUserWithToken` in db/fixtures.ts, used by `pnpm db:seed` and tests, leaves `expiresAt`
// null on purpose — dev/test tokens that never expire — so it is not reused here.)
const LOGIN_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Default (and, for now, only) `AuthProvider`: there is no external identity provider in the MVP
// (architecture.md §3), so identity is a local `users` row with an email + password hash. This
// replaced an earlier version that logged in with just an email (see docs/lgpd-review.md §3 — that
// was a live access-control gap, not a placeholder). A future external provider (OAuth/OIDC, SSO)
// can be plugged in later as another `AuthProvider`, without `routes/auth.ts` or `app.ts` changing.
export class LocalAuthProvider implements AuthProvider {
  constructor(private readonly db: Db) {}

  async register({ email, password }: RegisterCredentials): Promise<LoginResult | "email_taken"> {
    const normalized = email.trim().toLowerCase();
    const passwordHash = await hashPassword(password);

    try {
      return await this.db.transaction(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({ externalId: `local|${normalized}`, email: normalized, passwordHash })
          .returning();

        const suffix = randomBytes(4).toString("hex");
        const namePart = normalized.split("@")[0] || "user";
        const [org] = await tx
          .insert(organizations)
          .values({ name: `${namePart}'s organization`, slug: `${slugify(namePart)}-${suffix}` })
          .returning();
        await tx.insert(memberships).values({ organizationId: org.id, userId: user.id, role: "owner" });

        return issueToken(tx, user.id, org.id);
      });
    } catch (err) {
      if (isUniqueViolation(err, "users_email_idx") || isUniqueViolation(err, "users_external_id_idx")) {
        return "email_taken";
      }
      throw err;
    }
  }

  async login({ email, password }: LoginCredentials): Promise<LoginResult | null> {
    const normalized = email.trim().toLowerCase();
    if (!normalized) return null;

    const [user] = await this.db.select().from(users).where(eq(users.email, normalized)).limit(1);
    // Deliberately the same outcome (null) whether the email doesn't exist, has no password set
    // yet, or the password doesn't match — see the `login` doc comment on AuthProvider.
    if (!user?.passwordHash || !(await verifyPassword(password, user.passwordHash))) return null;

    return this.db.transaction(async (tx) => {
      // Reuse an organization the user already belongs to (oldest membership first), so that
      // logging in again doesn't spawn a new organization every time.
      const [existingMembership] = await tx
        .select({ organizationId: memberships.organizationId })
        .from(memberships)
        .where(eq(memberships.userId, user.id))
        .orderBy(memberships.createdAt)
        .limit(1);

      // A registered user always already has a membership (created in `register`), but fall back
      // to creating one rather than failing, in case a user predates that invariant.
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

      return issueToken(tx, user.id, organizationId);
    });
  }
}

async function issueToken(tx: Db, userId: string, organizationId: string): Promise<LoginResult> {
  const token = `rl_login_${randomBytes(24).toString("base64url")}`;
  await tx.insert(apiTokens).values({
    organizationId,
    userId,
    name: "login",
    tokenHash: hashToken(token),
    scopes: ["*"],
    expiresAt: new Date(Date.now() + LOGIN_TOKEN_TTL_MS),
  });

  return { userId, token };
}
