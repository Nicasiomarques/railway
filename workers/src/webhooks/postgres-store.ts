import { eq } from "drizzle-orm";
import { decryptValue, webhookDeliveries, webhookSubscriptions, type Db, type Keyring } from "@railway-like/db";
import type { RecordDeliveryInput, WebhookDeliveryStore, WebhookSubscriptionRecord } from "./store.js";

// Ties the ciphertext to the specific subscription, matching api/src/routes/webhooks.ts's contextFor.
const contextFor = (id: string) => `webhook_subscription:${id}`;

// Postgres store for the webhooks worker.
export class PostgresWebhookStore implements WebhookDeliveryStore {
  constructor(
    private readonly db: Db,
    private readonly keyring: Keyring,
  ) {}

  async getSubscription(id: string): Promise<WebhookSubscriptionRecord | null> {
    const [row] = await this.db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, id));
    if (!row) return null;
    return {
      id: row.id,
      url: row.url,
      secret: decryptValue(this.keyring, row.secret, contextFor(row.id)),
      isActive: row.isActive,
    };
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
