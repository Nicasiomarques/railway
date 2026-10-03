import { ApiError } from "../errors.js";

// Idempotency-Key é opcional, mas quando enviada precisa ser razoável.
export function idempotencyKeyHeader(headers: Record<string, unknown>): string | undefined {
  const raw = headers["idempotency-key"];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 255) {
    throw new ApiError(400, "invalid_idempotency_key", "Idempotency-Key deve ter entre 1 e 255 caracteres.");
  }
  return raw;
}
