import { resolveContext } from "../context.js";
import { apiRequest } from "../http.js";
import type { ListOf } from "../types.js";

type Extension = {
  id: string;
  name: string;
  description: string;
  url: string;
  events: string[];
  isActive: boolean;
};

function resolveOrgId(ctx: { project: { organizationId: string } | null }, override?: string): string {
  const organizationId = override ?? ctx.project?.organizationId;
  if (!organizationId) {
    throw new Error("No organization configured. Run `railway-like init` in the project directory, or use --organization <id>.");
  }
  return organizationId;
}

export async function extensionsListCommand(opts: { organization?: string } = {}): Promise<void> {
  const ctx = resolveContext();
  const organizationId = resolveOrgId(ctx, opts.organization);
  const { data } = await apiRequest<ListOf<Extension>>(ctx, "GET", `/organizations/${organizationId}/extensions`);
  for (const ext of data) {
    console.log(`${ext.id}\t${ext.name}\t${ext.description}\t${ext.events.join(",")}`);
  }
}

export async function extensionsInstallCommand(
  name: string,
  url: string,
  opts: { organization?: string; description?: string; secret?: string; events?: string },
): Promise<void> {
  const ctx = resolveContext();
  const organizationId = resolveOrgId(ctx, opts.organization);
  const ext = await apiRequest<Extension>(ctx, "POST", `/organizations/${organizationId}/extensions`, {
    json: {
      name,
      url,
      description: opts.description ?? name,
      secret: opts.secret,
      events: (opts.events ?? "").split(",").map((e) => e.trim()).filter(Boolean),
    },
  });
  console.log(`Extension "${ext.name}" (${ext.id}) installed.`);
}

export async function extensionsUninstallCommand(
  extensionId: string,
  opts: { organization?: string } = {},
): Promise<void> {
  const ctx = resolveContext();
  const organizationId = resolveOrgId(ctx, opts.organization);
  await apiRequest<void>(ctx, "DELETE", `/organizations/${organizationId}/extensions/${extensionId}`);
  console.log(`${extensionId} uninstalled.`);
}
