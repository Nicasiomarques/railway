import { sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { ApiError } from "./errors.js";

// Ordering by created_at with millisecond precision: the cursor carries the value in ISO format.
// Truncating in SQL keeps Postgres's microsecond precision from breaking the comparison.
export const createdAtMs = (column: PgColumn) => sql`date_trunc('milliseconds', ${column})`;

export type Cursor = { t: string; id: string };

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeCursor(raw: string | undefined): Cursor | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed.t === "string" && typeof parsed.id === "string") return parsed;
  } catch {
    // falls through to the error below
  }
  throw new ApiError(400, "invalid_cursor", "Invalid pagination cursor.");
}
