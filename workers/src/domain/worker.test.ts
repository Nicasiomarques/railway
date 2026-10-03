import { describe, expect, it, vi } from "vitest";
import { InMemoryDomainProvider } from "./in-memory.js";
import { InMemoryDomainStore } from "./in-memory-store.js";
import { handleIssueCertificateJob, processDomain } from "./worker.js";

const DOMAIN_ID = "dom-1";
const HOSTNAME = "api-ab12cd34.apps.railway.local";

function setup(checksToIssue = 1) {
  const store = new InMemoryDomainStore();
  store.add({ id: DOMAIN_ID, hostname: HOSTNAME, tlsState: "pending" });
  const provider = new InMemoryDomainProvider(checksToIssue);
  return { store, provider, deps: { store, provider } };
}

describe("processDomain", () => {
  it("a nonexistent domain returns not_found", async () => {
    const { deps } = setup();
    expect(await processDomain(deps, "outro-id")).toEqual({ kind: "not_found" });
  });

  it("issues and writes tls_state=issued when the provider confirms", async () => {
    const { deps, store } = setup(1);

    expect(await processDomain(deps, DOMAIN_ID)).toEqual({ kind: "issued" });
    expect((await store.get(DOMAIN_ID))!.tlsState).toBe("issued");
  });

  it("stays pending without changing the store while the provider hasn't confirmed", async () => {
    const { deps, store } = setup(2);

    expect(await processDomain(deps, DOMAIN_ID)).toEqual({ kind: "pending", reason: expect.any(String) });
    expect((await store.get(DOMAIN_ID))!.tlsState).toBe("pending");
  });

  it("is idempotent: an already-issued domain doesn't hit the provider again", async () => {
    const { deps, provider } = setup(1);
    await processDomain(deps, DOMAIN_ID);
    const spy = vi.spyOn(provider, "issueCertificate");

    expect(await processDomain(deps, DOMAIN_ID)).toEqual({ kind: "issued" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("a provider failure writes tls_state=failed with the reason", async () => {
    const { deps, store, provider } = setup();
    provider.markFailed(HOSTNAME, "DNS does not resolve to the edge's IP");

    expect(await processDomain(deps, DOMAIN_ID)).toEqual({ kind: "failed", reason: "DNS does not resolve to the edge's IP" });
    expect((await store.get(DOMAIN_ID))!.tlsState).toBe("failed");
  });
});

describe("handleIssueCertificateJob", () => {
  it("a pending result with budget left throws an error for BullMQ to retry", async () => {
    const { deps, store } = setup(3);

    await expect(
      handleIssueCertificateJob(deps, { domainId: DOMAIN_ID }, { attemptsMade: 0, maxAttempts: 5 }),
    ).rejects.toThrow(/attempt 1 of 5/);
    expect((await store.get(DOMAIN_ID))!.tlsState).toBe("pending");
  });

  it("on the last attempt without issuing, the domain goes to failed", async () => {
    const { deps, store } = setup(10);

    const result = await handleIssueCertificateJob(deps, { domainId: DOMAIN_ID }, { attemptsMade: 4, maxAttempts: 5 });

    expect(result.kind).toBe("failed");
    expect((await store.get(DOMAIN_ID))!.tlsState).toBe("failed");
  });

  it("issues within budget, without needing the last attempt", async () => {
    const { deps, store } = setup(1);

    const result = await handleIssueCertificateJob(deps, { domainId: DOMAIN_ID }, { attemptsMade: 0, maxAttempts: 5 });

    expect(result).toEqual({ kind: "issued" });
    expect((await store.get(DOMAIN_ID))!.tlsState).toBe("issued");
  });
});
