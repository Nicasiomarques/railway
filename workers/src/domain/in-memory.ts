import type { CertificateResult, CertificateStatus, DomainProvider } from "./adapter.js";

interface HostState {
  status: CertificateStatus;
  reason: string | null;
  checks: number;
}

// Simula o fluxo real (DNS → ACME → edge) sem nenhuma chamada externa: depois de `checksToIssue`
// verificações o certificado "emite", como se fosse a propagação de DNS e a validação ACME passando.
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

  // Testes: força o resultado de falha sem esperar as verificações simuladas.
  markFailed(hostname: string, reason = "falha simulada"): void {
    this.hosts.set(hostname, { status: "failed", reason, checks: this.hosts.get(hostname)?.checks ?? 0 });
  }
}
