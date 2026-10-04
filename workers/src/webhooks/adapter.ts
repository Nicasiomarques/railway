// Outbound webhook transport port (roadmap.md Phase 5: "Webhooks and extensions"). Only the
// webhooks worker (deliver.ts/worker.ts) calls this interface. Implementation: FetchWebhookTransport,
// using Node's native fetch — no retry logic here, BullMQ's job attempts/backoff own that (see
// shared/src/jobs.ts's DELIVER_WEBHOOK_JOB_RETRY and worker.ts).

import { createHmac } from "node:crypto";

// Signs the raw bytes with HMAC-SHA256, hex-encoded and "sha256="-prefixed. This is the exact
// scheme api/src/routes/github.ts verifies on receipt (see its `verifySignature`); here we're on
// the other side of that same contract, signing instead of checking.
export function signPayload(secret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

export interface WebhookTransport {
  // POSTs rawBody to url with the given headers. Only the response's status is needed by the
  // caller; a thrown error (network failure, DNS, timeout) is treated the same as a non-2xx status.
  send(url: string, rawBody: string, headers: Record<string, string>): Promise<{ status: number }>;
}

export class FetchWebhookTransport implements WebhookTransport {
  async send(url: string, rawBody: string, headers: Record<string, string>): Promise<{ status: number }> {
    const res = await fetch(url, { method: "POST", body: rawBody, headers });
    return { status: res.status };
  }
}
