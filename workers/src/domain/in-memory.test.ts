import { describe, expect, it } from "vitest";
import { InMemoryDomainProvider } from "./in-memory.js";

const HOSTNAME = "app.apps.railway.local";

describe("InMemoryDomainProvider", () => {
  it("fica pending até completar as verificações simuladas e só então emite", async () => {
    const provider = new InMemoryDomainProvider(2);

    const first = await provider.issueCertificate(HOSTNAME);
    expect(first).toEqual({ status: "pending", reason: null });

    const second = await provider.checkStatus(HOSTNAME);
    expect(second).toEqual({ status: "issued", reason: null });
  });

  it("é idempotente: emitir de novo um hostname já emitido não reinicia o fluxo", async () => {
    const provider = new InMemoryDomainProvider(1);
    await provider.issueCertificate(HOSTNAME);

    expect(await provider.issueCertificate(HOSTNAME)).toEqual({ status: "issued", reason: null });
  });

  it("checkStatus de hostname nunca emitido fica pending sem criar estado", async () => {
    const provider = new InMemoryDomainProvider();
    expect(await provider.checkStatus("nunca-emitido.apps.railway.local")).toEqual({ status: "pending", reason: null });
  });

  it("markFailed força o estado de falha com o motivo informado", async () => {
    const provider = new InMemoryDomainProvider();
    provider.markFailed(HOSTNAME, "limite de taxa do ACME");

    expect(await provider.checkStatus(HOSTNAME)).toEqual({ status: "failed", reason: "limite de taxa do ACME" });
  });

  it("release remove o estado: emitir de novo recomeça do zero", async () => {
    const provider = new InMemoryDomainProvider(1);
    await provider.issueCertificate(HOSTNAME);
    await provider.release(HOSTNAME);

    expect(await provider.checkStatus(HOSTNAME)).toEqual({ status: "pending", reason: null });
  });
});
