import type { CertificateResult, CertificateStatus, DomainProvider } from "./adapter.js";

interface HostState {
  status: CertificateStatus;
  reason: string | null;
  checks: number;
}

// Simulates the real flow (DNS → ACME → edge) with no external calls: after `checksToIssue`
// checks the certificate "issues", as if DNS propagation and ACME validation had passed.
export class InMemoryDomainProvider implements DomainProvider {
  private readonly hosts = new Map<string, HostState>();

  constructor(private readonly checksToIssue = 1) {}

  async issueCertificate(hostname: string): Promise<CertificateResult> {
    if (!this.hosts.has(hostname)) {
      this.hosts.set(hostname, { status: "pending", reason: null, checks: 0 });
    }
    return this.checkStatus(hostname);
  }

  async checkStatus(hostname: string): Promise<CertificateResult> {
    const state = this.hosts.get(hostname);
    if (!state) return { status: "pending", reason: null };
    if (state.status === "pending") {
      state.checks += 1;
      if (state.checks >= this.checksToIssue) state.status = "issued";
    }
    return { status: state.status, reason: state.reason };
  }

  async release(hostname: string): Promise<void> {
    this.hosts.delete(hostname);
  }

  // Tests: forces the failure result without waiting for the simulated checks.
  markFailed(hostname: string, reason = "simulated failure"): void {
    this.hosts.set(hostname, { status: "failed", reason, checks: this.hosts.get(hostname)?.checks ?? 0 });
  }
}
