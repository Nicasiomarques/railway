import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DELIVER_WEBHOOK_JOB_RETRY } from "@railway-like/shared";
import type { WebhookTransport } from "./adapter.js";
import { InMemoryWebhookStore } from "./in-memory-store.js";
import { deliverWebhook } from "./deliver.js";
import { handleDeliverWebhookJob } from "./worker.js";

const SUBSCRIPTION_ID = "sub-1";
const SECRET = "whsec_test_1234567890abcdef";
const URL = "https://example.com/hooks/railway-like";
const EVENT = "deployment.status_changed";
const PAYLOAD = { deploymentId: "dep-1", serviceInstanceId: "inst-1", status: "Queued", versionNo: 3 };

function setup(respond: (url: string, rawBody: string, headers: Record<string, string>) => Promise<{ status: number }>) {
  const store = new InMemoryWebhookStore();
  store.add({ id: SUBSCRIPTION_ID, url: URL, secret: SECRET, isActive: true });
  const transport: WebhookTransport = { send: respond };
  return { store, transport, subscription: { id: SUBSCRIPTION_ID, url: URL, secret: SECRET, isActive: true } };
}

describe("deliverWebhook", () => {
  it("signs the body with HMAC-SHA256 of the secret, hex-encoded and sha256=-prefixed", async () => {
    const seen: { headers?: Record<string, string>; body?: string } = {};
    const { store, transport, subscription } = setup(async (url, rawBody, headers) => {
      seen.headers = headers;
      seen.body = rawBody;
      return { status: 200 };
    });

    await deliverWebhook({ transport, store }, subscription, EVENT, PAYLOAD, 1);

    const expectedBody = JSON.stringify(PAYLOAD);
    const expectedSignature = `sha256=${createHmac("sha256", SECRET).update(expectedBody).digest("hex")}`;
    expect(seen.body).toBe(expectedBody);
    expect(seen.headers?.["X-Webhook-Signature"]).toBe(expectedSignature);
    expect(seen.headers?.["X-Webhook-Event"]).toBe(EVENT);
  });

  it("a different secret produces a different signature (so the receiver's HMAC check would reject it)", async () => {
    const { store, transport, subscription } = setup(async () => ({ status: 200 }));
    const seenSignatures: string[] = [];
    const spyTransport: WebhookTransport = {
      send: async (url, rawBody, headers) => {
        seenSignatures.push(headers["X-Webhook-Signature"]);
        return transport.send(url, rawBody, headers);
      },
    };

    await deliverWebhook({ transport: spyTransport, store }, subscription, EVENT, PAYLOAD, 1);
    await deliverWebhook({ transport: spyTransport, store }, { ...subscription, secret: "a-totally-different-secret" }, EVENT, PAYLOAD, 1);

    expect(seenSignatures[0]).not.toBe(seenSignatures[1]);
  });

  it("records a successful delivery in the store with deliveredAt set", async () => {
    const { store, transport, subscription } = setup(async () => ({ status: 204 }));

    const result = await deliverWebhook({ transport, store }, subscription, EVENT, PAYLOAD, 1);

    expect(result.status).toBe(204);
    expect(store.deliveries).toHaveLength(1);
    expect(store.deliveries[0]).toMatchObject({
      subscriptionId: SUBSCRIPTION_ID,
      event: EVENT,
      payload: PAYLOAD,
      responseStatus: 204,
      attempt: 1,
    });
    expect(store.deliveries[0].deliveredAt).toBeInstanceOf(Date);
  });

  it("throws on a non-2xx response, and still records the attempt with deliveredAt null", async () => {
    const { store, transport, subscription } = setup(async () => ({ status: 500 }));

    await expect(deliverWebhook({ transport, store }, subscription, EVENT, PAYLOAD, 2)).rejects.toThrow(/500/);

    expect(store.deliveries).toHaveLength(1);
    expect(store.deliveries[0].responseStatus).toBe(500);
    expect(store.deliveries[0].attempt).toBe(2);
    expect(store.deliveries[0].deliveredAt).toBeNull();
  });

  it("throws when the transport itself fails (network error), and still logs the attempt", async () => {
    const store = new InMemoryWebhookStore();
    store.add({ id: SUBSCRIPTION_ID, url: URL, secret: SECRET, isActive: true });
    const transport: WebhookTransport = {
      send: async () => {
        throw new Error("ECONNREFUSED");
      },
    };

    await expect(
      deliverWebhook({ transport, store }, { id: SUBSCRIPTION_ID, url: URL, secret: SECRET, isActive: true }, EVENT, PAYLOAD, 1),
    ).rejects.toThrow("ECONNREFUSED");

    expect(store.deliveries).toHaveLength(1);
    expect(store.deliveries[0].responseStatus).toBeNull();
    expect(store.deliveries[0].deliveredAt).toBeNull();
  });
});

describe("retry via BullMQ (shared/src/jobs.ts's DELIVER_WEBHOOK_JOB_RETRY)", () => {
  it("is configured with more than one attempt and a backoff, so BullMQ (not this module) retries", () => {
    expect(DELIVER_WEBHOOK_JOB_RETRY.attempts).toBeGreaterThan(1);
    expect(DELIVER_WEBHOOK_JOB_RETRY.backoff).toBeDefined();
  });
});

describe("handleDeliverWebhookJob", () => {
  it("skips (without delivering) when the subscription no longer exists", async () => {
    const store = new InMemoryWebhookStore();
    const result = await handleDeliverWebhookJob(
      { store, transport: { send: async () => ({ status: 200 }) } },
      { subscriptionId: "missing", event: EVENT, payload: PAYLOAD },
      1,
    );
    expect(result).toEqual({ kind: "skipped", reason: "not_found" });
    expect(store.deliveries).toHaveLength(0);
  });

  it("skips (without delivering) when the subscription was deactivated", async () => {
    const store = new InMemoryWebhookStore();
    store.add({ id: SUBSCRIPTION_ID, url: URL, secret: SECRET, isActive: false });
    const send = async () => ({ status: 200 });

    const result = await handleDeliverWebhookJob({ store, transport: { send } }, { subscriptionId: SUBSCRIPTION_ID, event: EVENT, payload: PAYLOAD }, 1);

    expect(result).toEqual({ kind: "skipped", reason: "inactive" });
    expect(store.deliveries).toHaveLength(0);
  });

  it("delivers and returns the response status for an active subscription", async () => {
    const store = new InMemoryWebhookStore();
    store.add({ id: SUBSCRIPTION_ID, url: URL, secret: SECRET, isActive: true });

    const result = await handleDeliverWebhookJob(
      { store, transport: { send: async () => ({ status: 200 }) } },
      { subscriptionId: SUBSCRIPTION_ID, event: EVENT, payload: PAYLOAD },
      1,
    );

    expect(result).toEqual({ kind: "delivered", status: 200 });
    expect(store.deliveries).toHaveLength(1);
  });

  it("propagates a delivery failure (so BullMQ retries the job), without swallowing it", async () => {
    const store = new InMemoryWebhookStore();
    store.add({ id: SUBSCRIPTION_ID, url: URL, secret: SECRET, isActive: true });

    await expect(
      handleDeliverWebhookJob(
        { store, transport: { send: async () => ({ status: 503 }) } },
        { subscriptionId: SUBSCRIPTION_ID, event: EVENT, payload: PAYLOAD },
        1,
      ),
    ).rejects.toThrow();
  });
});
