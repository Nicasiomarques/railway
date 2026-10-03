import { describe, expect, it } from "vitest";
import { InMemoryDomainProvider } from "./in-memory.js";

const HOSTNAME = "app.apps.railway.local";

describe("InMemoryDomainProvider", () => {
  it("stays pending until the simulated checks complete, and only then issues", async () => {
    const provider = new InMemoryDomainProvider(2);

    const first = await provider.issueCertificate(HOSTNAME);
    expect(first).toEqual({ status: "pending", reason: null });

    const second = await provider.checkStatus(HOSTNAME);
    expect(second).toEqual({ status: "issued", reason: null });
  });

  it("is idempotent: re-issuing an already-issued hostname doesn't restart the flow", async () => {
    const provider = new InMemoryDomainProvider(1);
    await provider.issueCertificate(HOSTNAME);

    expect(await provider.issueCertificate(HOSTNAME)).toEqual({ status: "issued", reason: null });
  });

  it("checkStatus of a never-issued hostname stays pending without creating state", async () => {
    const provider = new InMemoryDomainProvider();
    expect(await provider.checkStatus("never-issued.apps.railway.local")).toEqual({ status: "pending", reason: null });
  });

  it("markFailed forces the failure state with the given reason", async () => {
    const provider = new InMemoryDomainProvider();
    provider.markFailed(HOSTNAME, "ACME rate limit");

    expect(await provider.checkStatus(HOSTNAME)).toEqual({ status: "failed", reason: "ACME rate limit" });
  });

  it("release removes the state: re-issuing starts over from scratch", async () => {
    const provider = new InMemoryDomainProvider(1);
    await provider.issueCertificate(HOSTNAME);
    await provider.release(HOSTNAME);

    expect(await provider.checkStatus(HOSTNAME)).toEqual({ status: "pending", reason: null });
  });
});
