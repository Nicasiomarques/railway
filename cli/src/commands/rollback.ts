import { resolveContext } from "../context.js";
import { apiRequest } from "../http.js";
import type { Deployment } from "../types.js";

export async function rollbackCommand(deploymentId: string): Promise<void> {
  const ctx = resolveContext();

  // Rota documentada em docs/architecture.md §10 (`POST /v1/deployments/{id}:rollback`).
  const deployment = await apiRequest<Deployment>(ctx, "POST", `/deployments/${deploymentId}:rollback`);

  console.log(`Rollback criado: v${deployment.versionNo} (${deployment.id}), status ${deployment.status}.`);
}
