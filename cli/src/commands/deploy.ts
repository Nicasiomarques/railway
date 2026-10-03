import { resolveContext, resolveInstanceId } from "../context.js";
import { apiRequest } from "../http.js";
import type { Deployment, ListOf } from "../types.js";

// Manual redeploy: repeats the same image/commit as the last deployment, with a new env snapshot
// (architecture.md §5.2, "Manual redeploy"). The API doesn't build anything here.
export async function deployCommand(opts: { instance?: string } = {}): Promise<void> {
  const ctx = resolveContext();
  const instanceId = resolveInstanceId(ctx, opts.instance);

  const previous = await apiRequest<ListOf<Deployment>>(ctx, "GET", `/services/${instanceId}/deployments`, {
    query: { limit: 1 },
  });
  const last = previous.data[0];
  if (!last) {
    throw new Error(
      "This instance has no deployment yet; `deploy` only resends the last one's image/commit. Create the first deployment through the API.",
    );
  }

  const body = last.imageDigest ? { imageDigest: last.imageDigest } : { commitSha: last.commitSha };
  const deployment = await apiRequest<Deployment>(ctx, "POST", `/services/${instanceId}/deployments`, { json: body });

  console.log(`Deployment v${deployment.versionNo} (${deployment.id}) created with status ${deployment.status}.`);
}
