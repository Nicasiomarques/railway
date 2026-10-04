import { eq } from "drizzle-orm";
import { webhookDeliveries, webhookSubscriptions, type Db } from "@railway-like/db";
import type { RecordDeliveryInput, WebhookDeliveryStore, WebhookSubscriptionRecord } from "./store.js";

// Postgres store for the webhooks worker.
export class PostgresWebhookStore implements WebhookDeliveryStore {
  constructor(private readonly db: Db) {}

  async getSubscription(id: string): Promise<WebhookSubscriptionRecord | null> {
    const [row] = await this.db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, id));
    if (!row) return null;
    return { id: row.id, url: row.url, secret: row.secret, isActive: row.isActive };
  }

  async recordDelivery(input: RecordDeliveryInput): Promise<void> {
    await this.db.insert(webhookDeliveries).values({
      subscriptionId: input.subscriptionId,
      event: input.event,
      payload: input.payload,
      responseStatus: input.responseStatus,
      attempt: input.attempt,
      deliveredAt: input.deliveredAt,
    });
  }
}
