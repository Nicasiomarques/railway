import { and, eq } from "drizzle-orm";
import { domains, type Db } from "@railway-like/db";
import type { DomainRecord, DomainStore } from "./store.js";

// Store Postgres do worker de domínio.
export class PostgresDomainStore implements DomainStore {
  constructor(private readonly db: Db) {}

  async get(id: string): Promise<DomainRecord | null> {
    const [row] = await this.db.select().from(domains).where(eq(domains.id, id));
    if (!row) return null;
    return { id: row.id, hostname: row.hostname, tlsState: row.tlsState };
  }

  async setTlsState(id: string, from: string, to: string): Promise<boolean> {
    const updated = await this.db
      .update(domains)
      .set({ tlsState: to, updatedAt: new Date() })
      .where(and(eq(domains.id, id), eq(domains.tlsState, from)))
      .returning({ id: domains.id });
    return updated.length > 0;
  }
}
