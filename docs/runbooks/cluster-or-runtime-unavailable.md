# Runbook: cluster/runtime unavailable, or desired state diverging from actual

**Risk:** architecture.md §12 #6 (High). The runtime (k3s API, or the `RuntimeAdapter` it sits
behind) is unreachable, slow, or returning inconsistent state — deployments stuck, workloads not
matching what Postgres (the source of truth, architecture.md §1) says they should be.

## Symptoms

- Deployments stuck in `Building`/`Deploying`/`HealthChecking` far past what's normal (reconcile
  jobs re-enqueue themselves on a fixed interval while pending — `RECONCILE_JOB_RETRY` in
  `shared/src/jobs.ts`: 240 attempts × 5s ≈ 20 min budget before a deployment should ever still be
  stuck here).
- `kubectl --context <ctx> get nodes` / `get pods` is slow, erroring, or returns state that
  doesn't match what the API reports for the same service instance.
- A `DeploymentEvent` trail that stops advancing (architecture.md §4: `from_status`, `to_status`,
  `reason`, `ts` per deployment) is the first place to look — the deployment's own history tells
  you exactly which step it's stuck on.

## Immediate steps

1. **Confirm it's the runtime, not the platform.** Hit the runtime API directly, bypassing the
   reconciler:
   ```bash
   kubectl --context <ctx> get --raw /healthz
   kubectl --context <ctx> get nodes
   ```
   If this is slow/erroring too, it's the cluster — work the cluster problem (node health, API
   server load, etcd) before touching platform state at all. Don't retry deployments against a
   cluster that can't currently serve them; that just adds more stuck reconcile jobs on top of the
   backlog you'll have to clear once it's back.
2. **Once the runtime is healthy again**, reconciliation is idempotent by design
   (architecture.md §1, §6) — `applyWorkload`/`ensureNamespace`/etc. are all server-side-apply, so
   re-running them is always safe. The simplest recovery for a deployment stuck mid-flight is to
   re-enqueue its reconcile job rather than inventing a special recovery path:
   ```ts
   // same call the API makes on redeploy — see api/src/queue.ts's DeploymentQueue
   await queue.enqueueReconcile({ serviceInstanceId, versionNo });
   ```
3. **If a deployment exceeded its retry budget and is now `Failed`**, the previous version is
   still what's actually running (architecture.md §5.2 step 8: "Failure → keeps the previous
   version") — so there's no user-facing outage from this alone. A manual redeploy of the same
   SHA/digest is the way back in, same as any other failed deployment.

## Diagnosis: desired state vs. actual

- The reconciler's job is exactly this: converge actual state to desired (Postgres) state. If
  something looks wrong *after* the runtime recovered, that's either:
  - **A reconcile that hasn't run yet** — check whether its job is still queued/retrying
    (`shared/src/jobs.ts`'s `reconcileJobId` gives you the deterministic job id to look up: one job
    per `serviceInstanceId` + `versionNo`).
  - **An actual orphan** — a resource the runtime has that Postgres no longer references (a
    deleted service instance whose workload never got cleaned up). `architecture.md` §6 calls for
    "GC by reconciliation: orphaned resources are removed after a grace period" — **this isn't
    implemented as a generic sweep today**, only as the TTL-based environment decommission
    (`workers/src/decommission/`, for expired preview/CI environments specifically). A leftover
    workload from, say, a deleted service instance outside that path has no automated cleanup yet.
    Finding one of these during an incident is itself a signal to prioritize that gap, not just a
    one-off `kubectl delete` (though doing the one-off delete to resolve the immediate incident is
    still correct).

## Resolution

- Runtime-down incidents resolve when the runtime is healthy and the reconcile backlog has
  drained — confirm by checking that deployments are advancing again (new `DeploymentEvent` rows),
  not just that `kubectl` responds.
- A found orphan: delete it manually for now, and note it as evidence for prioritizing the orphan-GC
  gap above.

## Postmortem

Record: what made the runtime unavailable (node failure, API server overload, network partition
to the cluster), how long deployments were stuck, how many hit their retry budget and needed a
manual redeploy, and any orphaned resources found along the way.
