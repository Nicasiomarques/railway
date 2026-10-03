// Porta do provedor de domínio/TLS (architecture.md §6 e §8): hostname → DNS → certificado ACME → rota no edge.
// Só o worker de domínio chama esta interface. Implementações: InMemoryDomainProvider (testes e ambiente
// sem infra real). Uma implementação real de DNS/ACME fica para depois, atrás desta mesma porta.

export type CertificateStatus = "pending" | "issued" | "failed";

export interface CertificateResult {
  status: CertificateStatus;
  // Motivo legível quando status é "failed"; null nos demais casos.
  reason: string | null;
}

export interface DomainProvider {
  // Inicia o fluxo para o hostname: valida DNS, solicita o certificado ACME e prepara a rota no edge.
  // Idempotente: chamar de novo para um hostname já em andamento não reinicia o fluxo.
  issueCertificate(hostname: string): Promise<CertificateResult>;

  // Consulta o estado atual do fluxo, sem reiniciá-lo.
  checkStatus(hostname: string): Promise<CertificateResult>;

  // Desfaz: remove a rota no edge e libera/revoga o que foi reservado para o hostname (domínio removido).
  release(hostname: string): Promise<void>;
}
