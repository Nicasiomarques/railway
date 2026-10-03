// O que o worker de domínio precisa do Postgres. Espelha o DeploymentStore do reconciliador
// (reconciler/store.ts): o mínimo de leitura/escrita para o worker avançar o estado com segurança.
export interface DomainRecord {
  id: string;
  hostname: string;
  tlsState: string;
}

export interface DomainStore {
  get(id: string): Promise<DomainRecord | null>;

  // Compare-and-set: grava `to` só se o estado atual ainda for `from`. Retorna false em caso de corrida.
  setTlsState(id: string, from: string, to: string): Promise<boolean>;
}
