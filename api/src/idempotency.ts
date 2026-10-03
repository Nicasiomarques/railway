import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ApiError, isUniqueViolation } from "./errors.js";
import type { Db } from "./db/client.js";
import { idempotencyKeys } from "./db/schema.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type IdempotentResult = { status: number; body: unknown };

const CONSTRAINT = "idempotency_user_key_idx";

// Runs the operation inside a transaction and stores the response alongside the resource.
// Failures (ApiError) are not stored: the client can retry with the same key.
export async function runIdempotent(
  db: Db,
  opts: {
    userId: string;
    key: string | undefined;
    payload: unknown;
    run: (tx: Tx) => Promise<IdempotentResult>;
  },
): Promise<IdempotentResult> {
  const { userId, key, payload, run } = opts;

  if (!key) {
    return db.transaction(run);
  }

  const requestHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");

  const [existing] = await db
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)))
    .limit(1);

  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new ApiError(422, "idempotency_key_reused", "Idempotency-Key already used with a different request body.");
    }
    return { status: existing.responseStatus, body: existing.responseBody };
  }

  try {
    return await db.transaction(async (tx) => {
      const result = await run(tx);
      await tx.insert(idempotencyKeys).values({
        userId,
        key,
        requestHash,
        responseStatus: result.status,
        responseBody: result.body as object,
      });
      return result;
    });
  } catch (err) {
    if (isUniqueViolation(err, CONSTRAINT)) {
      throw new ApiError(409, "idempotency_conflict", "A request with this Idempotency-Key is already in progress.");
    }
    throw err;
  }
}
