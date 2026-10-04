import { readFileSync } from "node:fs";
import { resolveContext, resolveProjectId } from "../context.js";
import { apiRequest } from "../http.js";
import type { ListOf, Service } from "../types.js";

export async function importCommand(
  provider: string,
  file: string,
  opts: { project?: string } = {},
): Promise<void> {
  const ctx = resolveContext();
  const projectId = resolveProjectId(ctx, opts.project);
  const manifest = readFileSync(file, "utf8");

  const { data } = await apiRequest<ListOf<Service>>(ctx, "POST", `/projects/${projectId}/import`, {
    json: { provider, manifest },
  });
  for (const service of data) {
    console.log(`${service.name}\t${service.id}\t${service.instances.length} instance(s)`);
  }
}
