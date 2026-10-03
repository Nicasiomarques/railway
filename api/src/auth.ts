import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { ApiError } from "./errors.js";
import type { Db } from "./db/client.js";
import { apiTokens } from "./db/schema.js";

declare module "fastify" {
  interface FastifyRequest {
    auth?: { userId: string };
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Tokens são guardados só como hash; o valor original nunca fica no banco.
export function authenticate(db: Db) {
  return async function (request: FastifyRequest) {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
    if (!token) throw new ApiError(401, "unauthenticated", "Token de API ausente.");

    const [row] = await db
      .select({ userId: apiTokens.userId, expiresAt: apiTokens.expiresAt })
      .from(apiTokens)
      .where(eq(apiTokens.tokenHash, hashToken(token)))
      .limit(1);

    if (!row || (row.expiresAt && row.expiresAt <= new Date())) {
      throw new ApiError(401, "unauthenticated", "Token de API inválido ou expirado.");
    }
    request.auth = { userId: row.userId };
  };
}
