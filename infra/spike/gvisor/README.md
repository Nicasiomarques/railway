# Spike: build sandbox with gVisor

Goal: validate whether the build can run on a user-space kernel (gVisor) instead of the node's
kernel, and whether that removes the need for rootless BuildKit's concessions.

Install: `./install.sh` (checksums verified, `gvisor` RuntimeClass). Sandbox check: a pod with
`runtimeClassName: gvisor` reports kernel `4.4.0` (gVisor's fixed version), against the host's real
kernel.

## Measured results

| Question | Result |
|---|---|
| Does a pod run under gVisor on k3d? | Yes. Reported kernel 4.4.0 (gVisor) |
| Does the egress policy still hold under gVisor? | Yes. Cluster API gives `rc=7`, allowed host `200`, internet `200` (identical to runc) |
| Does cluster DNS work under gVisor? | Works for `kubernetes.default.svc`. `host.k3d.internal` **doesn't resolve** (a k3d detail, not gVisor's) |
| Build with `RUN npm install` under gVisor, process sandbox on, native snapshotter | **Yes** (Node app with no Dockerfile, published and pulled by digest) |
| Overlay snapshotter (rootless default) under gVisor | **No**: `mount callback failed … transport endpoint is not connected` (FUSE) |
| Rootless BuildKit without seccomp `Unconfined` and without privilege escalation | **No**: `newuidmap` needs setuid, blocked without escalation |
| Root BuildKit, seccomp `RuntimeDefault`, no escalation, with `SYS_ADMIN` (+ `SYS_PTRACE`, `NET_ADMIN` etc.) | **No, at `RUN`**: clone, detect and pull succeed; `runc` fails with `setns: operation not permitted` entering the container's mount namespace. Doesn't improve with `--oci-worker-no-process-sandbox` |

## What this means

- gVisor adds the kernel barrier: a build escape lands in the sandbox, not on the node's kernel.
- The seccomp `Unconfined` and privilege-escalation concessions **remain** for rootless BuildKit.
  gVisor doesn't eliminate them on its own.
- Current production default: `runtimeClass: gvisor`, `--oci-worker-snapshotter=native`, process
  sandbox on.

## Root-cause investigation conclusion

No combination tested removes the need for rootless BuildKit's concessions under gVisor. gVisor
doesn't implement the `setns` for mount namespaces that `runc` uses in root mode. The only way to
truly isolate without these concessions is a different isolation model: a microVM
(Kata/Firecracker), which requires `/dev/kvm` on the node. k3d on Docker Desktop doesn't expose
KVM, so this is only testable on a dedicated Linux node.

## Pending

- Measure the native snapshotter's cost (layer copying) on large builds.
- Egress policy with real DNS (today the build needs an IP for the test host).
