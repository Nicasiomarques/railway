# Local development environment

Manual setup until a `docker-compose` and CI exist. Everything below runs on Docker Desktop.

## Services

| Service | How to start it | Host port |
|---|---|---|
| Postgres | local install (Homebrew) | 5432 |
| Redis | `docker run -d --name railway-redis -p 6379:6379 redis:7-alpine` | 6379 |
| k3s cluster | `k3d cluster create railway-dev --agents 1 --registry-use k3d-railway-reg:5000 --wait` | — |
| Registry | `k3d registry create railway-reg --port 5050` | 5050 |

Notes:
- Port 5000 is often taken on macOS (AirPlay). That's why the registry uses 5050 on the host.
- Inside the cluster, the registry is `k3d-railway-reg:5000` (that's what the nodes pull from and what the build publishes to).
- From the host, the same registry is `localhost:5050`.

## Test repo for builds

Pods clone over HTTP, so the repo needs to be served from somewhere the cluster can reach:

```bash
git clone --bare <repo> /tmp/build-src/app.git
git -C /tmp/build-src/app.git update-server-info
python3 -m http.server 8189 --bind 0.0.0.0 --directory /tmp/build-src
```

In the cluster, the host shows up as `host.k3d.internal`. The repo URL is `http://host.k3d.internal:8189/app.git`.

## Test databases

- `railway_like` — API dev.
- `railway_like_test` — API tests.
- `railway_like_workers_test` — workers tests and E2E. Only a role with create-database permission can create it: `createdb -U postgres railway_like_workers_test`.

Migrations: `DATABASE_URL=... npx drizzle-kit migrate` inside `api/`, for each database.

## Variables

- API: `DATABASE_URL`, `REDIS_URL`, `ENCRYPTION_KEYS`, `ENCRYPTION_CURRENT_KID`, `PORT`.
- Workers: the same encryption and Redis ones, plus `RECONCILER_RUNTIME=k8s`, `K8S_CONTEXT`, `BUILD_REGISTRY=k3d-railway-reg:5000`, `METRICS_PORT` (default `9102`, see `docs/slos.md`).

## Known limitations

- Builds require seccomp `Unconfined` and `allowPrivilegeEscalation` on the build container, because of rootless BuildKit. The `builds` namespace has PSA `privileged`. This is the project's main security concession; real isolation (microVM or gVisor) is still a spike.
- There's no egress policy in the `builds` namespaces.

## Build egress

The `builds` namespaces block private networks. For the build to reach the registry and the test repo, configure:

```bash
export BUILD_EGRESS_ALLOW=172.24.0.2/32:5000,192.168.65.254/32:8189
```

- `172.24.0.2` is the registry's IP on the k3d network (check with `docker inspect k3d-railway-reg`).
- `192.168.65.254` is Docker Desktop's `host.k3d.internal` (check with `nslookup host.k3d.internal` from inside a pod).

An init container gate waits for the policy to be active before the clone, because kube-router programs it with a delay at pod start.

## Build sandbox (gVisor)

Builds run by default under `RuntimeClass gvisor`. To install it on the k3d nodes:

```bash
infra/spike/gvisor/install.sh
```

Worker defaults: `BUILD_RUNTIME_CLASS=gvisor`, BuildKit process sandbox on, native snapshotter (`--oci-worker-snapshotter=native`). To turn it off: `BUILD_RUNTIME_CLASS=""` (default runtime) or `BUILD_PROCESS_SANDBOX=none`.

Details and what still requires concessions: `infra/spike/gvisor/README.md`.

## Environment provisioning

`provision-environment` job (saga in `workers/src/provisioning/`), with state in `environments.provisioning_*`. Steps, in this order, all idempotent upserts:

1. `namespace`: `env-<environmentId>` with labels `platform/project`, `platform/env` and PSA `restricted`.
2. `default-deny-policy`: a NetworkPolicy that denies ingress and egress for every pod in the namespace.
3. `quota`: LimitRange (per-container default: request 100m/128Mi, limit 500m/512Mi) and ResourceQuota (requests 2 CPU/4Gi, limits 4 CPU/8Gi, 20 pods).

Verified on k3d with `K8S_TEST_CONTEXT=k3d-railway-dev`: a workload with no `resources` comes up inside the environment with the LimitRange's defaults.

Not wired up yet:
- No API route creates environments, and nothing enqueues the job. Today the environment only comes in through the seed.
- The reconciler doesn't wait for the saga to finish: a workload can get applied before the namespace has its policies.
- The egress policy denies DNS and the internet. Allowances (DNS, edge, traffic between services, egress) don't exist yet; an app that resolves external names hasn't been tested in this state.
- There's no secret-store scope (the "secret store" step from architecture.md §6): secrets stay envelope-encrypted in Postgres.

## Host name DNS

`host.k3d.internal` stopped resolving inside the cluster after restarting the nodes (to install gVisor). Use the host's IP in the test repos and in `BUILD_EGRESS_ALLOW`: `192.168.65.254` on Docker Desktop. Check with `nslookup host.k3d.internal` from inside a pod.
