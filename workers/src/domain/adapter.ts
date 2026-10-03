// Domain/TLS provider port (architecture.md §6 and §8): hostname → DNS → ACME certificate → edge route.
// Only the domain worker calls this interface. Implementations: InMemoryDomainProvider (tests and
// environments without real infra). A real DNS/ACME implementation comes later, behind this same port.

export type CertificateStatus = "pending" | "issued" | "failed";

export interface CertificateResult {
  status: CertificateStatus;
  // Human-readable reason when status is "failed"; null otherwise.
  reason: string | null;
}

export interface DomainProvider {
  // Starts the flow for the hostname: validates DNS, requests the ACME certificate and sets up the edge route.
  // Idempotent: calling it again for a hostname already in progress doesn't restart the flow.
  issueCertificate(hostname: string): Promise<CertificateResult>;

  // Checks the flow's current state, without restarting it.
  checkStatus(hostname: string): Promise<CertificateResult>;

  // Undoes it: removes the edge route and releases/revokes whatever was reserved for the hostname (domain removed).
  release(hostname: string): Promise<void>;
}
