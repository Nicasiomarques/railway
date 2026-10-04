import type { DecommissionEnvironmentJobData } from "@railway-like/shared";
import { namespaceFor } from "../runtime/adapter.js";
import type { EnvironmentRuntime } from "../runtime/environment.js";
import type { DecommissionStore } from "./store.js";

export interface DecommissionDeps {
  store: DecommissionStore;
  runtime: Pick<EnvironmentRuntime, "deleteNamespace">;
}

export type DecommissionResult =
  | { kind: "decommissioned"; environmentId: string }
  | { kind: "missing"; environmentId: string }
  | { kind: "not_due"; environmentId: string };

// Tears down an environment whose TTL has passed: a PR preview marked for removal
// (api/src/routes/github.ts), or, once ephemeral CI environments exist, one of those. This is the
// provisioning saga's counterpart (../provisioning/saga.ts) -- where that applies namespace,
// default-deny-policy and quota in order, this undoes all three in one call by deleting the
// namespace itself (architecture.md §7.2: one namespace per environment), instead of tearing down
// each service instance's workload individually.
//
// Re-checks ttlAt against the current time rather than trusting the caller: the sweep that
// enqueues this job (workers/src/decommission/worker.ts) reads the DB once per tick, so a TTL
// bumped (e.g. the PR reopened, api/src/routes/github.ts sets ttlAt back to null) after that read
// but before this job runs must not destroy a now-wanted environment.
export async function decommissionEnvironment(
  deps: DecommissionDeps,
  { environmentId }: DecommissionEnvironmentJobData,
): Promise<DecommissionResult> {
  const env = await deps.store.findEnvironment(environmentId);
  if (!env) return { kind: "missing", environmentId };
  if (!env.ttlAt || env.ttlAt.getTime() > Date.now()) return { kind: "not_due", environmentId };

  await deps.runtime.deleteNamespace(namespaceFor(environmentId));

  const instanceIds = await deps.store.listServiceInstanceIds(environmentId);
  for (const instanceId of instanceIds) {
    await deps.store.deleteDomains(instanceId);
    await deps.store.markServiceInstanceDeleted(instanceId);
  }
  await deps.store.markEnvironmentDeleted(environmentId);
  return { kind: "decommissioned", environmentId };
}
