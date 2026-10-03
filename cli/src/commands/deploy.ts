import { resolveContext, resolveInstanceId } from "../context.js";
import { apiRequest } from "../http.js";
import type { Deployment, ListOf } from "../types.js";

// Redeploy manual: repete a mesma imagem/commit do último deployment, com um snapshot de env novo
// (architecture.md §5.2, "Redeploy manual"). A API não builda nada aqui.
export async function deployCommand(opts: { instance?: string } = {}): Promise<void> {
  const ctx = resolveContext();
  const instanceId = resolveInstanceId(ctx, opts.instance);

  const previous = await apiRequest<ListOf<Deployment>>(ctx, "GET", `/services/${instanceId}/deployments`, {
    query: { limit: 1 },
  });
  const last = previous.data[0];
  if (!last) {
    throw new Error(
      "Esta instância ainda não tem nenhum deployment; `deploy` só reenvia a imagem/commit do último. Crie o primeiro deployment pela API.",
    );
  }

  const body = last.imageDigest ? { imageDigest: last.imageDigest } : { commitSha: last.commitSha };
  const deployment = await apiRequest<Deployment>(ctx, "POST", `/services/${instanceId}/deployments`, { json: body });

  console.log(`Deployment v${deployment.versionNo} (${deployment.id}) criado com status ${deployment.status}.`);
}
