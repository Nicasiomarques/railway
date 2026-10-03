import { createDb, type Db } from "@railway-like/db";

export const { db, pool } = createDb();
export type { Db };
