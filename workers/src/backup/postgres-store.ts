import { and, eq } from "drizzle-orm";
import { volumes, type Db } from "@railway-like/db";
import type { BackupStore, VolumeRecord } from "./store.js";

// Postgres store for the backup worker.
export class PostgresBackupStore implements BackupStore {
  constructor(private readonly db: Db) {}

  async get(id: string): Promise<VolumeRecord | null> {
    const [row] = await this.db.select().from(volumes).where(eq(volumes.id, id));
    if (!row) return null;
    return { id: row.id, backupState: row.backupState, lastBackupAt: row.lastBackupAt };
  }

  async setBackupState(id: string, from: string, to: string, lastBackupAt?: Date | null): Promise<boolean> {
    const set: { backupState: string; updatedAt: Date; lastBackupAt?: Date | null } = {
      backupState: to,
      updatedAt: new Date(),
    };
    if (lastBackupAt !== undefined) set.lastBackupAt = lastBackupAt;

    const updated = await this.db
      .update(volumes)
      .set(set)
      .where(and(eq(volumes.id, id), eq(volumes.backupState, from)))
      .returning({ id: volumes.id });
    return updated.length > 0;
  }
}
