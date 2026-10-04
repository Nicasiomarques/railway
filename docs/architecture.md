# Architecture

PaaS platform inspired by Railway: `Connect → Configure → Deploy → Observe → Scale`.

> Status: draft. Decisions marked **[OPEN]** depend on validation in Phase 0 (see `roadmap.md`).

---

## 1. Principles

- **Modular monolith + workers**, not microservices. Modules with clear boundaries, ready to become services later.
- **Postgres is the source of truth.** The runtime is just observed state.
- **Reconciliation, not direct commands.** Deploy changes the desired state; a reconciler converges the runtime.
- **Idempotent and resumable jobs.** Every step records progress.
- **Convention over configuration.** Automatic detection, override always available.

---

## 2. Overview

```
                 ┌────────────────────────────┐
  Browser ─────▶ │  Web (React)               │
  CLI     ─────▶ │  Public API (REST/OpenAPI) │◀──── GitHub App webhooks
                 └──────────────┬─────────────┘
                                │
                 ┌──────────────▼─────────────┐
                 │  Core domain (modules):    │
                 │  auth · projects · envs ·  │
                 │  services · vars · domains │
                 │  deployments · usage       │
                 └───────┬─────────────┬──────┘
                         │ Postgres    │ Job queue
                 ┌───────▼─────┐  ┌────▼────────────────────────┐
                 │ Source of   │  │ Workers                     │
                 │ truth       │  │  · build-orchestrator       │
                 └─────────────┘  │  · deploy-reconciler        │
                                  │  · domain/TLS              │
                                  │  · usage-aggregator         │
                                  │  · preview-janitor          │
                                  └───┬─────────────┬───────────┘
                                      │             │
                   ┌──────────────────▼──┐   ┌──────▼──────────────────┐
                   │ Build farm          │   │ Runtime adapter         │
                   │ (BuildKit rootless, │   │ (K8s today; interface   │
                   │  in sandbox)        │   │  allows swapping)       │
                   └──────────┬──────────┘   └──────┬──────────────────┘
                              │ image digest         │
                   ┌──────────▼──────────┐   ┌──────▼──────────────────┐
                   │ Registry            │   │ Edge (ingress + TLS)    │
                   └─────────────────────┘   │ Observability           │
                                             └─────────────────────────┘
```

---

## 3. Components

| Component | Responsibility | Note |
|---|---|---|
| Web | Dashboard, canvas, logs, metrics | SPA (React) |
| API | All exposed functionality; auth; validation | Same API for web, CLI and integrations |
| Auth | Login, sessions, API tokens, RBAC | External provider in the MVP |
| GitHub integration | Webhooks, checks, installation tokens | GitHub App, not OAuth App |
| Detector | Analyzes repo and suggests a build/run plan | Pure function: file tree → plan + justifications |
| Build orchestrator | Creates build jobs, cache, timeouts, cancellation | Cancels stale builds of the same service |
| Builder | Runs build in sandbox and publishes image by digest | BuildKit rootless; Buildpacks for languages |
| Deploy reconciler | Converts deployment into workload | Only component that writes to the runtime |
| Runtime adapter | `createWorkload`, `setReplicas`, `getStatus`, `tailLogs` | Abstraction for swapping the backend |
| Edge controller | Routing by host, certificates, domains | Consumes `domains` state |
| Log pipeline | Collects stdout/stderr, indexes, real-time tail | Storage outside Postgres |
| Metrics pipeline | CPU, memory, network, restarts | Aggregated per instance |
| Usage aggregator | Samples → `usage_events` per project/service | Feeds future billing |
| Preview janitor | TTL, sleep and preview cleanup | Periodic job |

---

## 4. Data model

Central distinction: **Service** is the definition; **ServiceInstance** is the service within an environment, with its own configs and deployments.

```text
Organization ─┬─ Membership (user, role)
              └─ Project
                   ├─ Environment (name, type: production|staging|preview|custom,
                   │               parent_env_id, branch_rule, ttl_at, sleep_policy)
                   ├─ Service (name, kind, source: github_repo|image|template,
                   │           root_dir, detection_snapshot)
                   │     └─ ServiceInstance (service_id, environment_id,
                   │                         resources, replicas, health_check, overrides)
                   │           ├─ Deployment (commit_sha, branch, author, version_no,
                   │           │              status, image_digest, env_snapshot_id,
                   │           │              triggered_by)
                   │           │     ├─ Build (logs_ref, cache_key, duration, exit_code)
                   │           │     └─ DeploymentEvent (from_status, to_status, reason, ts)
                   │           ├─ Domain (hostname, type: auto|custom, tls_state)
                   │           └─ Volume (size, mount_path)
                   ├─ Variable (scope: project|environment|service_instance,
                   │            key, value_enc, is_secret, version)
                   ├─ Connection (from_instance → to_instance)
                   └─ GitHubRepoLink (installation_id, repo_id, branch→env rules)

Platform:
  Runtime (cluster/region) · UsageEvent · AuditLog · Job · ApiToken
  EnvSnapshot (immutable set of variables at deploy time)
```

**Modeling decisions**
- `EnvSnapshot` immutable per deployment: rollback restores the snapshot, not the current state of the variables.
- Inheritance resolved in the order service-instance → environment → project, recorded in the snapshot.
- `version_no` sequential per ServiceInstance.
- Secrets with envelope encryption; never logged.
- `usage_events` append-only, aggregated in windows (1 min → hour → day).
- Soft delete for projects and services.

---

## 5. Deployment flow

### 5.1 State machine

```
Queued ──▶ Building ──▶ Deploying ──▶ HealthChecking ──▶ Running ──▶ Superseded
   │           │             │               │                   └──▶ RolledBack
   └───────────┴─────────────┴───────────────┴──▶ Failed
   Cancelled: from any non-terminal state
```

`Crashed` is a **runtime** state, not a deployment state.

### 5.2 Step by step

1. `push` webhook → validates `X-Hub-Signature-256` → responds 202 → enqueues (idempotent by `X-GitHub-Delivery`).
2. Resolves ServiceInstances whose `branch_rule` matches the branch and whose `root_dir` was affected by the diff.
3. Creates `Deployment(Queued)` with SHA, author and message; cancels previous non-terminal deployments of the same instance.
4. Creates a check run on GitHub (and a GitHub Deployment, if a linked environment exists).
5. Build: short-lived installation token → clone at the exact SHA → detector (if there is no saved config) → build in sandbox → push by digest.
6. Snapshot: resolves variables and references, records `EnvSnapshot`.
7. Deploy: reconciler creates/updates workload with `image@digest`, snapshot, limits and health check. The previous version remains active.
8. Health check: N successful probes within the timeout. Failure → keeps the previous version; deployment becomes `Failed` with a human-readable reason.
9. Traffic switch at the edge; previous version becomes `Superseded`, available for rollback.
10. Updates the check/status on GitHub and fires notifications.

**Rollback:** new deployment of type `rollback` pointing to the `image_digest` and `EnvSnapshot` of a previous version. **Does not rebuild.**

**Manual redeploy:** same SHA/digest with a new env snapshot (or rebuild, by explicit choice).

---

## 6. Infrastructure provisioning

Infra operations are sagas of persisted, idempotent steps.

```text
CreateEnvironment(prod)
  1. reserve namespace/logical identifier   [idempotent by env_id]
  2. apply default-deny NetworkPolicy
  3. apply ResourceQuota and LimitRange
  4. create scope in the secret store
  5. mark env as READY
```

- Each step records status; resumes from the point of failure.
- Every resource receives the labels `platform/project`, `platform/env`, `platform/instance`.
- GC by reconciliation: orphaned resources are removed after a grace period.
- Decommissioning (TTL sweep, `workers/src/decommission`): the inverse saga. A periodic sweep (every 5 minutes) finds environments whose `ttl_at` has passed — a PR preview marked for removal, or an ephemeral CI environment — and deletes the environment's whole namespace in one call (undoing steps 1–3 above together), then releases its domains and soft-deletes its service instances and itself.
- Template marketplace (roadmap.md Phase 5, `shared/src/templates.ts`, `api/src/routes/templates.ts`): a static catalog over the existing `*_template` service sources (Postgres, Redis, MinIO) — `GET /templates` lists it, `POST /projects/:id/templates/:source/deploy` creates a preconfigured service the same way `POST /projects/:id/services` would, so a caller doesn't need to know the source enum values by hand.
- Import (roadmap.md Phase 5, `api/src/import/manifest.ts`, `api/src/routes/import.ts`): `POST /projects/:id/import` parses a Heroku `app.json`, a Render `render.yaml` or a generic project-export JSON into one or more services (each with its own repo, kind and literal env vars), then creates all of them the same way the marketplace route does — atomically, inside one transaction, so a later name collision rolls back the whole import instead of leaving it half-done.
- Stateful (Postgres/Redis/volumes): PVC + scheduled backup (volume snapshot + logical dump) to object storage; restore is an explicit, audited operation.
- Domain: hostname → DNS (wildcard for automatic subdomain) → certificate → route on the edge. Each step visible to the user.

---

## 7. Workload isolation

### 7.1 Runtime

**Decided:** k3s behind a `RuntimeAdapter`. Keeps the Kubernetes API (namespaces, NetworkPolicy, ResourceQuota) with much less operational overhead than a managed cluster.

| Option | Pros | Cons |
|---|---|---|
| **k3s (chosen)** | Full Kubernetes API in a single binary; no change to the isolation model | Operating the cluster yourself |
| Managed Kubernetes | Ecosystem, network and volume control | Heavy operations |
| Container serverless (Cloud Run / ECS Fargate) | Little ops; fast for web/worker | Limited stateful and private networking |
| Nomad / Docker on VMs / custom Firecracker | Minimal ops or strong isolation | Smaller ecosystem or lots of platform work |

Isolation of untrusted code (builds and workloads) still requires gVisor, Kata or a microVM, regardless of the orchestrator. See 7.2.

### 7.2 Layers

- **Builds:** dedicated nodes; BuildKit rootless without `privileged`; egress restricted to registries and GitHub; CPU/memory/time limited; ideally in a microVM (Kata/Firecracker).
- **Workloads:**
  - One namespace **per environment** (prod isolated from preview).
  - Default-deny NetworkPolicy; explicit allowance of ingress via the edge, traffic between services in the same environment, and egress to the internet.
  - Blocking of `169.254.169.254` and the platform's internal networks.
  - Pod Security `restricted`; non-root; no capabilities; seccomp `RuntimeDefault`.
  - Runtime sandbox (gVisor or Kata) for untrusted tenants.
  - `ResourceQuota` per project; `requests`/`limits` per service.
- **Secrets:** never in a ConfigMap; Secret with encryption at rest or External Secrets Operator; rotation triggers a new deployment.
- **Control plane separated** from the customers' data plane.

---

## 8. GitHub integration

- **GitHub App** (not OAuth App): granular permissions, 1h installation tokens, rate limit per installation.
- Permissions: `contents: read`, `metadata: read`, `pull_requests: read`, `checks: write`, `deployments: write`, `statuses: write`.
- Events: `push`, `pull_request`, `installation`, `installation_repositories`.
- User login (identity) separate from the installation (access to repos).
- Webhooks: HMAC validation, idempotency by delivery ID, never trust the payload for permissions.
- **Fork PRs do not receive secrets** and are blocked by default.
- Installation tokens generated on demand, never persisted.

**Branch → environment mapping** (ordered, configurable globs):
```text
main        → Production
develop     → Staging
feature/*   → Preview (phase 2)
```

**Preview per PR (phase 2):** `opened/synchronize` creates/updates `pr-N`; `closed` schedules removal; single comment on the PR, edited on each update; inherits Staging variables with override.

**Status:** "Build", "Deploy" and "Health" check runs per deployment, with a link to the logs. Commit ↔ deployment linked by SHA on every screen.

---

## 9. Observability

**Logs**
- Per-node agent (Vector or Fluent Bit) reads stdout/stderr and adds labels `project`, `env`, `instance`, `deployment_id`.
- Storage: Loki or VictoriaLogs in the MVP; ClickHouse if search needs demand it.
- Build and runtime on the same pipeline, distinguished by `stream=build|runtime`.
- Tail via SSE with a cursor for reconnection.
- Retention by plan; archiving to object storage.

**Metrics**
- CPU, memory, network and disk from kubelet/cAdvisor (or equivalent) → Prometheus/VictoriaMetrics.
- Restarts and uptime derived from runtime events.
- Application metrics via `OTEL_EXPORTER_OTLP_ENDPOINT` injected as a variable.
- Allowed labels: `project`, `env`, `instance`. Never `commit` or `deployment_id`.

**Health:** deployment status (state machine) kept separate from runtime status (`running`, `crashlooping`, `sleeping`, `stopped`). Errors go through a translator into human-readable language with a suggested action.

**Platform:** OpenTelemetry traces per job; queue metrics; deploy-time and build-time SLOs.
First slice implemented: `GET /metrics` (api) and `GET /metrics` on `METRICS_PORT` (workers)
expose Prometheus-format HTTP and job metrics; see `docs/slos.md` for the series and the SLOs
defined on top of them, and for what is still missing (traces, logs, dashboards, alerting).

---

## 10. API

REST with OpenAPI as the contract. CLI and web consume the same API.

```text
GET    /v1/projects
POST   /v1/projects
GET    /v1/projects/{project}/environments
POST   /v1/projects/{project}/services
PUT    /v1/projects/{project}/environments/{env}/services/{svc}/config

GET    /v1/services/{instance}/deployments
POST   /v1/services/{instance}/deployments            (redeploy)
POST   /v1/deployments/{id}:rollback
POST   /v1/deployments/{id}:cancel
GET    /v1/deployments/{id}/logs?stream=build|runtime (SSE)

GET    /v1/services/{instance}/variables
PUT    /v1/services/{instance}/variables/{key}
POST   /v1/services/{instance}/domains
GET    /v1/services/{instance}/metrics?from=&to=&metric=

POST   /v1/github/webhooks
GET    /v1/operations/{id}
```

**Conventions**
- Actions as `:verb` when they are not CRUD.
- `Idempotency-Key` on POSTs that create resources or trigger jobs.
- Long-running operations return `202` with `operation_id`.
- Cursor-based pagination; errors in RFC 9457 (`problem+json`) with a stable `code`.
- Versioning by path (`/v1`).
- API tokens with scope and expiration.
- Rate limit per token and per organization.

**CLI:** `login` (device flow), `init`, `deploy`, `logs`, `status`, `rollback`, `env`, `domain`.

---

## 11. Information architecture (frontend)

```text
Sidebar
├── Projects
│   └── Project
│       ├── Canvas (default view: services and connections of the environment)
│       ├── Environments [switcher: Production | Staging | Preview-N]
│       ├── Services → Service detail
│       │     ├── Deployments (commit, author, status, rollback)
│       │     ├── Logs (build | runtime, search, tail)
│       │     ├── Metrics (CPU, RAM, network, restarts, uptime)
│       │     ├── Variables (visible inheritance, masked secrets)
│       │     ├── Networking (domains, ports, internal network)
│       │     └── Settings (source, branch rules, resources, health check, root dir)
│       ├── Volumes & Backups
│       └── Project settings (environments, members, integrations)
├── New (wizard: Repo → Branch → Detection → Confirmation → Deploy)
├── Integrations (GitHub App)
├── Team & Access
├── Usage & Billing
└── Audit log
```

- Wizard with a final review of what was detected and what will be created.
- Progressive configuration: basics visible, "Advanced" collapsed.
- Canvas: nodes = services, edges = connections (inject variables). Visualization first; editing later.
- Deployment drawer: commit, variable diff vs. previous version, logs and rollback.

---

## 12. Technical risks

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| 1 | Build code escaping the sandbox | Critical | microVM for builds, restricted egress, dedicated nodes, no privileges |
| 2 | Secrets leakage | Critical | Masking, envelope encryption, fork blocking |
| 3 | Wrong runtime chosen | High | `RuntimeAdapter`; spike with A and B |
| 4 | Egress and log costs above revenue | High | Quotas, limited retention, usage from day 1, sleep |
| 5 | Wrong service vs. instance model | High | `ServiceInstance` from the start |
| 6 | Desired state diverging from actual | High | Idempotent reconciler; orphan GC |
| 7 | Let's Encrypt/DNS rate limit | Medium | Wildcard, certificate reuse, issuance queue |
| 8 | GitHub rate limit | Medium | Per-installation tokens, cache, webhooks |
| 9 | Insufficient Postgres/Redis backup | Critical | Automated backup, restore testing, UI warnings |
| 10 | Rollback broken by migration or env | High | Immutable snapshot; migration warning; pre-deploy command |
| 11 | Wrong detection | Medium | Visible justification, override, test corpus |
| 12 | Abuse (mining, spam) | High | Quotas, account verification, pattern detection |
| 13 | Log volume overwhelming the pipeline | High | Per-instance rate limit, sampling at peak |
| 14 | LGPD and data residency | High | Explicit region; DPA; minimal personal data in logs |
| 15 | Canvas delaying the product | Medium | Visualization first; editor later |
