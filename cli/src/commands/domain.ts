import { resolveContext, resolveInstanceId } from "../context.js";
import { apiRequest } from "../http.js";
import type { Domain, ListOf } from "../types.js";

export async function domainListCommand(opts: { instance?: string } = {}): Promise<void> {
  const ctx = resolveContext();
  const instanceId = resolveInstanceId(ctx, opts.instance);

  const result = await apiRequest<ListOf<Domain>>(ctx, "GET", `/services/${instanceId}/domains`);
  if (result.data.length === 0) {
    console.log("No domains configured for this instance.");
    return;
  }

  console.log("Hostname                                       Type      TLS state");
  for (const d of result.data) {
    console.log(`${d.hostname.padEnd(47)} ${d.type.padEnd(9)} ${d.tlsState}`);
  }
}

export async function domainAddCommand(
  opts: { instance?: string; type?: string; hostname?: string } = {},
): Promise<void> {
  if (opts.type !== "auto" && opts.type !== "custom") {
    throw new Error('--type must be "auto" or "custom".');
  }
  if (opts.type === "custom" && !opts.hostname) {
    throw new Error("--hostname is required for --type custom.");
  }
  if (opts.type === "auto" && opts.hostname) {
    throw new Error("--type auto generates the hostname automatically; don't pass --hostname.");
  }

  const ctx = resolveContext();
  const instanceId = resolveInstanceId(ctx, opts.instance);

  const domain = await apiRequest<Domain>(ctx, "POST", `/services/${instanceId}/domains`, {
    json: { type: opts.type, hostname: opts.hostname },
  });
  console.log(`Domain created: ${domain.hostname} (${domain.id}), type ${domain.type}, TLS state ${domain.tlsState}.`);
}

export async function domainRemoveCommand(domainId: string, opts: { instance?: string } = {}): Promise<void> {
  const ctx = resolveContext();
  const instanceId = resolveInstanceId(ctx, opts.instance);

  await apiRequest<void>(ctx, "DELETE", `/services/${instanceId}/domains/${domainId}`);
  console.log(`${domainId} removed.`);
}
