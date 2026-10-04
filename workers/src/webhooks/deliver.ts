import { signPayload, type WebhookTransport } from "./adapter.js";
import type { WebhookDeliveryStore, WebhookSubscriptionRecord } from "./store.js";

export interface DeliverWebhookDeps {
  transport: WebhookTransport;
  store: WebhookDeliveryStore;
}

export interface DeliverWebhookResult {
  status: number | null;
}

// POSTs `event`/`payload` to the subscription's URL, signed the same way api/src/routes/github.ts
// verifies GitHub's inbound signature (HMAC-SHA256 over the exact bytes sent) — see adapter.ts's
// signPayload. Logs the attempt to webhook_deliveries (via `store`) regardless of outcome, success
// or failure.
//
// Throws on anything but a 2xx response (or on a transport error, e.g. the endpoint being
// unreachable) so BullMQ's attempts/backoff — configured on the job, not here — retries it. This
// function has no retry logic of its own: `attempt` is only recorded for the log, not decided here.
export async function deliverWebhook(
  deps: DeliverWebhookDeps,
  subscription: WebhookSubscriptionRecord,
  event: string,
  payload: unknown,
  attempt: number,
): Promise<DeliverWebhookResult> {
  const rawBody = JSON.stringify(payload);
  const signature = signPayload(subscription.secret, rawBody);

  let status: number | null = null;
  let transportError: unknown;
  try {
    const res = await deps.transport.send(subscription.url, rawBody, {
      "content-type": "application/json",
      "X-Webhook-Event": event,
      "X-Webhook-Signature": signature,
    });
    status = res.status;
  } catch (err) {
    transportError = err;
  }

  const delivered = status !== null && status >= 200 && status < 300;
  await deps.store.recordDelivery({
    subscriptionId: subscription.id,
    event,
    payload,
    responseStatus: status,
    attempt,
    deliveredAt: delivered ? new Date() : null,
  });

  if (!delivered) {
    throw transportError ?? new Error(`webhook delivery failed with status ${status}`);
  }
  return { status };
}
