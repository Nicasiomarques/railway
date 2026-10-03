import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

// Each app creates its own pool: API and workers don't share connections or module state.
export function createDb(connectionString = process.env.DATABASE_URL ?? "postgres://railway:railway@localhost:5432/railway_like"): { db: Db; pool: Pool } {
  const pool = new Pool({ connectionString });
  return { db: drizzle({ client: pool, schema }), pool };
}
