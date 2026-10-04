import type { UsageInstanceInfo, UsageSample, UsageStore } from "./store.js";

// In-memory store for tests. Mirrors the Postgres contract, including recordSample's append-only
// behavior (rows accumulate in `samples` instead of being read back through the interface, since
// nothing in the contract needs to read a sample back).
export class InMemoryUsageStore implements UsageStore {
  private readonly instances = new Map<string, UsageInstanceInfo>();
  readonly samples: UsageSample[] = [];

  add(instance: UsageInstanceInfo): void {
    this.instances.set(instance.id, { ...instance });
  }

  remove(id: string): void {
    this.instances.delete(id);
  }

  async getInstance(id: string): Promise<UsageInstanceInfo | null> {
    const row = this.instances.get(id);
    return row ? { ...row } : null;
  }

  async recordSample(sample: UsageSample): Promise<void> {
    this.samples.push({ ...sample });
  }

  async listActiveInstanceIds(): Promise<string[]> {
    return [...this.instances.keys()];
  }
}
