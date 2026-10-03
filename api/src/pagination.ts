import { sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { ApiError } from "./errors.js";

// Ordenação por created_at com precisão de milissegundos: o cursor carrega o valor em ISO.
// Truncar no SQL evita que a precisão de microssegundos do Postgres quebre a comparação.
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
    // cai no erro abaixo
  }
  throw new ApiError(400, "invalid_cursor", "Cursor de paginação inválido.");
}
