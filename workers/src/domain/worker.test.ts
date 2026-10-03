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
  it("domínio inexistente volta not_found", async () => {
    const { deps } = setup();
    expect(await processDomain(deps, "outro-id")).toEqual({ kind: "not_found" });
  });

  it("emite e grava tls_state=issued quando o provider confirma", async () => {
    const { deps, store } = setup(1);

    expect(await processDomain(deps, DOMAIN_ID)).toEqual({ kind: "issued" });
    expect((await store.get(DOMAIN_ID))!.tlsState).toBe("issued");
  });

  it("fica pending sem alterar o store enquanto o provider não confirma", async () => {
    const { deps, store } = setup(2);

    expect(await processDomain(deps, DOMAIN_ID)).toEqual({ kind: "pending", reason: expect.any(String) });
    expect((await store.get(DOMAIN_ID))!.tlsState).toBe("pending");
  });

  it("é idempotente: domínio já issued não bate no provider de novo", async () => {
    const { deps, provider } = setup(1);
    await processDomain(deps, DOMAIN_ID);
    const spy = vi.spyOn(provider, "issueCertificate");

    expect(await processDomain(deps, DOMAIN_ID)).toEqual({ kind: "issued" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("falha do provider grava tls_state=failed com o motivo", async () => {
    const { deps, store, provider } = setup();
    provider.markFailed(HOSTNAME, "DNS não resolve para o IP do edge");

    expect(await processDomain(deps, DOMAIN_ID)).toEqual({ kind: "failed", reason: "DNS não resolve para o IP do edge" });
    expect((await store.get(DOMAIN_ID))!.tlsState).toBe("failed");
  });
});

describe("handleIssueCertificateJob", () => {
  it("pendência com orçamento sobrando lança erro para o BullMQ re-tentar", async () => {
    const { deps, store } = setup(3);

    await expect(
      handleIssueCertificateJob(deps, { domainId: DOMAIN_ID }, { attemptsMade: 0, maxAttempts: 5 }),
    ).rejects.toThrow(/tentativa 1 de 5/);
    expect((await store.get(DOMAIN_ID))!.tlsState).toBe("pending");
  });

  it("na última tentativa sem emitir, o domínio vai para failed", async () => {
    const { deps, store } = setup(10);

    const result = await handleIssueCertificateJob(deps, { domainId: DOMAIN_ID }, { attemptsMade: 4, maxAttempts: 5 });

    expect(result.kind).toBe("failed");
    expect((await store.get(DOMAIN_ID))!.tlsState).toBe("failed");
  });

  it("emite dentro do orçamento, sem precisar da última tentativa", async () => {
    const { deps, store } = setup(1);

    const result = await handleIssueCertificateJob(deps, { domainId: DOMAIN_ID }, { attemptsMade: 0, maxAttempts: 5 });

    expect(result).toEqual({ kind: "issued" });
    expect((await store.get(DOMAIN_ID))!.tlsState).toBe("issued");
  });
});
