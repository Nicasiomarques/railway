import type { RecordDeliveryInput, WebhookDeliveryStore, WebhookSubscriptionRecord } from "./store.js";

// In-memory store for tests. Mirrors the Postgres contract (postgres-store.ts); `deliveries`
// records every call to recordDelivery, in order, for assertions.
export class InMemoryWebhookStore implements WebhookDeliveryStore {
  private readonly subscriptions = new Map<string, WebhookSubscriptionRecord>();
  readonly deliveries: RecordDeliveryInput[] = [];

  add(subscription: WebhookSubscriptionRecord): void {
    this.subscriptions.set(subscription.id, { ...subscription });
  }

  async getSubscription(id: string): Promise<WebhookSubscriptionRecord | null> {
    const row = this.subscriptions.get(id);
    return row ? { ...row } : null;
  }

  async recordDelivery(input: RecordDeliveryInput): Promise<void> {
    this.deliveries.push({ ...input });
  }
}
