import type { FastifyBaseLogger } from "fastify";

// Extension points for what the architecture (docs/architecture.md §8) calls an "installation
// token" and "check runs": at this stage there are no real GitHub App credentials in the
// environment, so each interface has a "noop" implementation that only logs. Swapping in a real
// call to the GitHub API is just implementing the interface and injecting it in place of the
// noop (see app.ts).

export interface GitHubInstallationTokenClient {
  // Generates a short-lived installation token (~1h). The result is never persisted to the
  // database (architecture.md §8): the caller uses the token on the spot and discards it.
  getInstallationToken(log: FastifyBaseLogger, installationId: bigint): Promise<string>;
}

export class NoopGitHubInstallationTokenClient implements GitHubInstallationTokenClient {
  async getInstallationToken(log: FastifyBaseLogger, installationId: bigint): Promise<string> {
    log.info({ installationId: installationId.toString() }, "github: installation token generation (noop)");
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
  // Creates or updates a check run ("Build", "Deploy", "Health" — architecture.md §8) on the commit.
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
