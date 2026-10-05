import { resolveContext, resolveInstanceId } from "../context.js";
import { apiRequest } from "../http.js";
import type { ListOf, VariableListItem } from "../types.js";

export async function envListCommand(opts: { instance?: string } = {}): Promise<void> {
  const ctx = resolveContext();
  const instanceId = resolveInstanceId(ctx, opts.instance);

  const result = await apiRequest<ListOf<VariableListItem>>(ctx, "GET", `/services/${instanceId}/variables`);
  if (result.data.length === 0) {
    console.log("No variables defined for this instance.");
    return;
  }

  for (const v of result.data) {
    const value = v.isSecret ? "(secret)" : v.value ?? "";
    console.log(`${v.key}=${value}`);
  }
}

export async function envSetCommand(assignment: string, opts: { instance?: string; secret?: boolean } = {}): Promise<void> {
  const separator = assignment.indexOf("=");
  if (separator <= 0) {
    throw new Error("Use the `KEY=VALUE` format.");
  }
  const key = assignment.slice(0, separator);
  const value = assignment.slice(separator + 1);

  const ctx = resolveContext();
  const instanceId = resolveInstanceId(ctx, opts.instance);

  const result = await apiRequest<{ key: string; version: number }>(
    ctx,
    "PUT",
    `/services/${instanceId}/variables/${encodeURIComponent(key)}`,
    { json: { value, isSecret: opts.secret ?? false } },
  );
  console.log(`${result.key} saved (version ${result.version}).`);
}

export async function envUnsetCommand(key: string, opts: { instance?: string } = {}): Promise<void> {
  const ctx = resolveContext();
  const instanceId = resolveInstanceId(ctx, opts.instance);

  await apiRequest<void>(ctx, "DELETE", `/services/${instanceId}/variables/${encodeURIComponent(key)}`);
  console.log(`${key} removed.`);
}
