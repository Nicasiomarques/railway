import { resolveContext, resolveProjectId } from "../context.js";
import { apiRequest } from "../http.js";
import type { Environment } from "../types.js";

export async function ciEnvCreateCommand(
  opts: { project?: string; name?: string; ttl?: string } = {},
): Promise<void> {
  const ctx = resolveContext();
  const projectId = resolveProjectId(ctx, opts.project);
  const ttlSeconds = Number(opts.ttl ?? 600);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error("--ttl must be a positive number of seconds.");
  }

  const env = await apiRequest<Environment>(ctx, "POST", `/projects/${projectId}/environments/ci`, {
    json: { name: opts.name, ttlSeconds },
  });
  // Printed on its own line, first: a CI job scripts off this (e.g. `ID=$(railway-like ci-env create | tail -1)`).
  console.log(env.id);
  console.log(`Environment "${env.name}" created (${env.id}), torn down automatically at ${env.ttlAt}.`);
}

export async function ciEnvDestroyCommand(environmentId: string, opts: { project?: string } = {}): Promise<void> {
  const ctx = resolveContext();
  const projectId = resolveProjectId(ctx, opts.project);

  await apiRequest<void>(ctx, "DELETE", `/projects/${projectId}/environments/${environmentId}`);
  console.log(`${environmentId} scheduled for immediate teardown.`);
}
