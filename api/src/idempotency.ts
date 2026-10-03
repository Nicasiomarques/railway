import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ApiError, isUniqueViolation } from "./errors.js";
import type { Db } from "./db/client.js";
import { idempotencyKeys } from "./db/schema.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type IdempotentResult = { status: number; body: unknown };

const CONSTRAINT = "idempotency_user_key_idx";

// Executa a operação dentro de uma transação e grava a resposta junto com o recurso.
// Falhas (ApiError) não são gravadas: o cliente pode repetir com a mesma chave.
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
      throw new ApiError(422, "idempotency_key_reused", "Idempotency-Key já usada com outro corpo de requisição.");
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
      throw new ApiError(409, "idempotency_conflict", "Requisição com esta Idempotency-Key já está em andamento.");
    }
    throw err;
  }
}
