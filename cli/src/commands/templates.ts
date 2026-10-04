import { resolveContext, resolveProjectId } from "../context.js";
import { apiRequest } from "../http.js";
import type { ListOf, MarketplaceTemplate, Service } from "../types.js";

export async function templatesListCommand(): Promise<void> {
  const ctx = resolveContext();
  const { data } = await apiRequest<ListOf<MarketplaceTemplate>>(ctx, "GET", "/templates");
  for (const t of data) {
    console.log(`${t.source}\t${t.name}\t${t.description}`);
  }
}

export async function templateDeployCommand(
  source: string,
  opts: { project?: string; name?: string } = {},
): Promise<void> {
  const ctx = resolveContext();
  const projectId = resolveProjectId(ctx, opts.project);
  const service = await apiRequest<Service>(ctx, "POST", `/projects/${projectId}/templates/${source}/deploy`, {
    json: { name: opts.name },
  });
  console.log(`Service "${service.name}" (${service.id}) created from template "${source}".`);
}
