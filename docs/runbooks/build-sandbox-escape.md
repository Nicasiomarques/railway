# Runbook: build sandbox escape

**Risk:** architecture.md §12 #1 (Critical). A build (rootless BuildKit, under gVisor —
`infra/spike/gvisor/`) does something a build shouldn't: reaching outside its namespace, touching
the node, or behaving like it broke out of its sandbox.

## Symptoms

- A build pod's egress hits something outside the allowed destinations configured via
  `BUILD_EGRESS_ALLOW` (registry + served repo only — see `infra/README.md` "Build egress").
- A build pod shows processes, mounts, or syscalls inconsistent with "clone repo, run detected
  build steps, push image" (e.g. attempts to read `/proc`, `/var/run/docker.sock`, node-local
  paths, or the cloud metadata endpoint `169.254.169.254`).
- `k3s`/kubelet logs on a build node show a container escaping its cgroup/namespace, or gVisor
  (`runsc`) logs a denied syscall.

## Immediate containment

1. **Identify the build pod and its node.**
   ```bash
   kubectl --context <ctx> -n builds get pods -o wide -l platform/workload
   ```
2. **Cordon the node** so nothing new schedules there while you investigate:
   ```bash
   kubectl --context <ctx> cordon <node>
   ```
3. **Kill the build pod.** `workers/src/build/cancel.ts` (`handleCancelBuildJob`, the
   `CANCEL_BUILD_JOB` job on the `deployments` queue) is the normal path and is what the API's
   deployment-cancel route (`POST /v1/deployments/{id}/cancel`) already uses — prefer it over a
   bare `kubectl delete pod` when the deployment is known, since it also marks the `Deployment`
   row `Cancelled` instead of leaving it stuck. If the deployment is unknown or the normal path
   doesn't respond, `kubectl delete pod --now` is the fallback.
4. **Do not reuse the node** for builds until it's rebuilt from the base image. A node a build
   escaped on is not a node to trust for the next build.

## Diagnosis

- Pull the build pod's logs before deleting it (`kubectl logs`, both the `buildkitd` sidecar and
  the step container) and the `containerd`/`runsc` logs on the node
  (`/var/log/` paths per `infra/spike/gvisor/README.md`'s "Measured results" table for what
  "normal" gVisor denial output looks like, to compare against).
- Check the `BUILD_EGRESS_ALLOW` NetworkPolicy actually matched what was configured for that build
  (`kubectl -n builds get networkpolicy -o yaml`) — a misconfigured egress allow-list is a much
  more likely cause than an actual sandbox break, and worth ruling out first.
- Known, already-accepted concessions (not escapes): rootless BuildKit needs seccomp `Unconfined`
  and `allowPrivilegeEscalation` (`infra/README.md` "Known limitations") — this is expected and is
  not, by itself, a signal of a break.

## Resolution

- If it's confirmed as an actual sandbox break (not a policy misconfiguration): this is the
  scenario `architecture.md` §12 #1 calls Critical impact, and `infra/spike/gvisor/README.md`'s
  root-cause section already concludes gVisor doesn't remove BuildKit's root-mode concessions — a
  real fix is a microVM (Kata/Firecracker, needs `/dev/kvm` on the node, not available on k3d on
  Docker Desktop) rather than a config change. Escalate past this runbook; don't ship a quick patch
  that only re-narrows the egress policy and call the underlying risk closed.
- If it's a misconfigured egress allow-list: fix `BUILD_EGRESS_ALLOW` for the affected
  environment/CI config and re-run.

## Postmortem

Record: which image/repo triggered it, what the sandbox actually let through, whether it's a gap
in gVisor's syscall coverage or a policy misconfiguration, and whether `infra/spike/gvisor/`'s
"Pending" section needs a new line.
