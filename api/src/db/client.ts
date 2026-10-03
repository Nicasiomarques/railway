import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://railway:railway@localhost:5432/railway_like",
});

export const db = drizzle({ client: pool, schema });
export type Db = typeof db;
