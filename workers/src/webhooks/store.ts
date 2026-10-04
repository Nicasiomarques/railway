// What the webhooks worker needs from Postgres. Mirrors the domain worker's DomainStore
// (domain/store.ts) and the backup worker's BackupStore (backup/store.ts): the minimal read/write
// needed for the worker to safely deliver and log an attempt.

export interface WebhookSubscriptionRecord {
  id: string;
  url: string;
  secret: string;
  isActive: boolean;
}

export interface RecordDeliveryInput {
  subscriptionId: string;
  event: string;
  payload: unknown;
  responseStatus: number | null;
  attempt: number;
  // Set only when the delivery succeeded (a 2xx response); null otherwise, same as
  // webhook_deliveries.delivered_at (db/src/schema.ts).
  deliveredAt: Date | null;
}

export interface WebhookDeliveryStore {
  getSubscription(id: string): Promise<WebhookSubscriptionRecord | null>;

  // Logs one delivery attempt (db/src/schema.ts's webhook_deliveries), in the spirit of
  // audit_logs: lets an operator see why a subscriber's endpoint isn't receiving events.
  recordDelivery(input: RecordDeliveryInput): Promise<void>;
}
