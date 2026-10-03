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
    console.log("No deployments found for this instance.");
    return;
  }

  const current = result.data.find((d) => d.status === "Running");
  console.log(`Instance: ${instanceId}`);
  console.log(`Current state: ${current ? `v${current.versionNo} (${current.id}) Running` : "no Running deployment"}`);
  console.log("");
  console.log("Version  Status          Trigger   Deployment                            Created at");
  for (const d of result.data) {
    console.log(
      `${String(d.versionNo).padEnd(7)} ${d.status.padEnd(15)} ${d.trigger.padEnd(9)} ${d.id}  ${d.createdAt}`,
    );
  }
}
