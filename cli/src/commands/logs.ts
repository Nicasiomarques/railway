import { resolveContext, resolveInstanceId, type Context } from "../context.js";
import { apiRequest, streamLines } from "../http.js";
import type { BuildLog, Deployment, ListOf } from "../types.js";

export type LogsOptions = {
  instance?: string;
  deployment?: string;
  stream?: string;
  since?: string;
};

// Mirrors the lookup in status.ts/deploy.ts: without --deployment, tails the instance's current
// (most recent Running) deployment.
async function resolveDeploymentId(ctx: Context, instanceId: string, override?: string): Promise<string> {
  if (override) return override;

  const result = await apiRequest<ListOf<Deployment>>(ctx, "GET", `/services/${instanceId}/deployments`, {
    query: { limit: 10 },
  });
  const current = result.data.find((d) => d.status === "Running");
  if (!current) {
    throw new Error(
      "No Running deployment found for this instance. Use --deployment <id> to pick one explicitly.",
    );
  }
  return current.id;
}

export async function logsCommand(opts: LogsOptions = {}): Promise<void> {
  if (opts.stream !== undefined && opts.stream !== "build" && opts.stream !== "runtime") {
    throw new Error('--stream must be "build" or "runtime".');
  }

  const ctx = resolveContext();
  const instanceId = resolveInstanceId(ctx, opts.instance);
  const deploymentId = await resolveDeploymentId(ctx, instanceId, opts.deployment);

  if (!opts.stream) {
    const log = await apiRequest<BuildLog>(ctx, "GET", `/deployments/${deploymentId}/logs`);
    if (!log.content) {
      console.log("No logs captured yet for this deployment.");
      return;
    }
    console.log(log.content);
    return;
  }

  // Live tail: prints each line as it arrives and keeps the connection open until the server
  // closes it or the user interrupts (Ctrl+C), handled below so it exits cleanly instead of
  // printing a stack trace.
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on("SIGINT", onSigint);

  try {
    await streamLines(
      ctx,
      `/deployments/${deploymentId}/logs`,
      (line) => {
        process.stdout.write(`${line}\n`);
      },
      {
        query: { stream: opts.stream, since: opts.since },
        signal: controller.signal,
      },
    );
  } finally {
    process.off("SIGINT", onSigint);
  }
}
