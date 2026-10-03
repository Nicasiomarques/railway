import type { DomainRecord, DomainStore } from "./store.js";

// In-memory store for tests. Mirrors the Postgres contract, including setTlsState's compare-and-set.
export class InMemoryDomainStore implements DomainStore {
  private readonly rows = new Map<string, DomainRecord>();

  add(record: DomainRecord): void {
    this.rows.set(record.id, { ...record });
  }

  async get(id: string): Promise<DomainRecord | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async setTlsState(id: string, from: string, to: string): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.tlsState !== from) return false;
    row.tlsState = to;
    return true;
  }
}
