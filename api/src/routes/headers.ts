import { ApiError } from "../errors.js";

// Idempotency-Key is optional, but when sent it needs to be reasonable.
export function idempotencyKeyHeader(headers: Record<string, unknown>): string | undefined {
  const raw = headers["idempotency-key"];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 255) {
    throw new ApiError(400, "invalid_idempotency_key", "Idempotency-Key must be between 1 and 255 characters.");
  }
  return raw;
}
