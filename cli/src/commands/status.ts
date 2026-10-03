import { resolveContext, resolveInstanceId } from "../context.js";
import { apiRequest } from "../http.js";
import type { Deployment, ListOf } from "../types.js";

export async function statusCommand(opts: { instance?: string } = {}): Promise<void> {
  const ctx = resolveContext();
  const instanceId = resolveInstanceId(ctx, opts.instance);

  const result = await apiRequest<ListOf<Deployment>>(ctx, "GET", `/services/${instanceId}/deployments`, {
    query: { limit: 10 },
  });

  if (result.data.length === 0) {
    console.log("Nenhum deployment encontrado para esta instância.");
    return;
  }

  const current = result.data.find((d) => d.status === "Running");
  console.log(`Instância: ${instanceId}`);
  console.log(`Estado atual: ${current ? `v${current.versionNo} (${current.id}) Running` : "nenhum deployment Running"}`);
  console.log("");
  console.log("Versão  Status          Trigger   Deployment                            Criado em");
  for (const d of result.data) {
    console.log(
      `${String(d.versionNo).padEnd(7)} ${d.status.padEnd(15)} ${d.trigger.padEnd(9)} ${d.id}  ${d.createdAt}`,
    );
  }
}
