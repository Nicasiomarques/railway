import type { FastifyBaseLogger } from "fastify";

// Pontos de extensão para o que a arquitetura (docs/architecture.md §8) chama de "token de
// instalação" e "check runs": nesta fase não há credenciais reais de GitHub App no ambiente,
// então cada interface tem uma implementação "noop" que só loga. Trocar por uma chamada real à
// API do GitHub é só implementar a interface e injetar no lugar da noop (ver app.ts).

export interface GitHubInstallationTokenClient {
  // Gera um token de instalação de curta duração (±1h). O resultado nunca é persistido no banco
  // (architecture.md §8): quem chama usa o token na hora e descarta.
  getInstallationToken(log: FastifyBaseLogger, installationId: bigint): Promise<string>;
}

export class NoopGitHubInstallationTokenClient implements GitHubInstallationTokenClient {
  async getInstallationToken(log: FastifyBaseLogger, installationId: bigint): Promise<string> {
    log.info({ installationId: installationId.toString() }, "github: geração de token de instalação (noop)");
    return "noop-installation-token";
  }
}

export type GitHubCheckStatus = "queued" | "in_progress" | "completed";
export type GitHubCheckConclusion = "success" | "failure" | "cancelled";

export interface GitHubCheckRunInput {
  installationId: bigint;
  repoId: bigint;
  commitSha: string;
  name: string;
  status: GitHubCheckStatus;
  conclusion?: GitHubCheckConclusion;
}

export interface GitHubChecksClient {
  // Cria ou atualiza um check run ("Build", "Deploy", "Health" — architecture.md §8) no commit.
  upsertCheckRun(log: FastifyBaseLogger, input: GitHubCheckRunInput): Promise<void>;
}

export class NoopGitHubChecksClient implements GitHubChecksClient {
  async upsertCheckRun(log: FastifyBaseLogger, input: GitHubCheckRunInput): Promise<void> {
    log.info(
      { repoId: input.repoId.toString(), commitSha: input.commitSha, name: input.name, status: input.status },
      "github: check run (noop)",
    );
  }
}
