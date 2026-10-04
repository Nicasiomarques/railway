# Roadmap

See `architecture.md` for the technical design.

---

## Decisions to make before Phase 1

1. ~~**Runtime:**~~ **Decided: k3s** behind a `RuntimeAdapter`. See `architecture.md` §7.1.
2. **Cloud and region:** São Paulo (latency and LGPD) or global from the start.
3. ~~**Stack:**~~ **Decided: TypeScript end to end.** Fastify + Zod (API and OpenAPI), Drizzle + Postgres, BullMQ + Redis (job queue), `@kubernetes/client-node` (runtime), React + Vite (web), CLI in Node, pnpm + Turborepo.
4. **Customers' Postgres/Redis:** containers with a volume or managed service behind the same API.
5. **Team size and timeline** for the MVP.
6. **Open source or not:** self-hosting changes multi-tenancy and installation requirements.

---

## Phase 0 — Technical spike (2–3 weeks)

**Out of scope for this phase:** authentication. The spike runs without login, external provider or RBAC; access is local and restricted to the test environment. Auth returns in Phase 1.

- Manual end-to-end pipeline: Node repo → build in sandbox → image → workload → URL with HTTPS.
- Stand up a k3s cluster and validate with a real app: deploy, NetworkPolicy between namespaces and build isolation.
- Validate the detector with 30–50 public repos per language.
- **Output:** runtime decision, stack confirmed, draft data model.

## Phase 1 — Foundations (4–6 weeks)

- Monorepo with modules: `api`, `web`, `workers`, `cli`, `shared`.
- Auth, organizations, projects, environments; API v1 with OpenAPI.
- Complete data model (even if some tables are not yet used).
- Job queue, deployment state machine, reconciler.
- `RuntimeAdapter` with the initial implementation.

## Phase 2 — MVP (6–8 weeks)

- GitHub App: installation, webhooks, checks.
- Build and detection: Dockerfile, Node, Python, Go.
- Deploy, redeploy, rollback, health checks, restarts.
- Variables with inheritance, references and snapshot.
- Real-time logs and basic metrics.
- Automatic domain and custom domain with TLS.
- Postgres and Redis templates with daily backup.
- Web (dashboard, wizard, deployments, logs, variables) and minimal CLI.
- Closed beta with 10–20 users.

**Acceptance criteria:** on a typical Node repo, from "Connect GitHub" to a public URL with HTTPS, without editing files, in under 5 minutes on the happy path.

**Out of the MVP:** preview environments, editable canvas, workers, cron, object storage, generic volumes, autoscaling, billing, multi-region, private networking between projects, dedicated Java/PHP, SSO.

## Phase 3 — Hardening (3–4 weeks)

- Isolation tests: build escape, metadata access, secrets leakage. First slice: NetworkPolicy/
  quota/Pod-Security tests against a real cluster in CI (`.github/workflows/ci.yml`'s `isolation`
  job) — build-sandbox tests (registry + gVisor) still run locally only.
- Quotas, rate limiting, abuse prevention. Implemented: `api/src/quota.ts`, `@fastify/rate-limit`.
- Backup restore testing; incident runbooks. Restore is now a real, audited operation
  (`POST /v1/volumes/{volumeId}/restore`), tested against both outcomes. Runbooks: `docs/runbooks/`.
- Platform observability and SLOs. First slice: `GET /metrics` on both processes — see `docs/slos.md`.
- LGPD and terms review.

## Phase 4 — Product (ongoing)

- Preview environments per PR.
- Cron jobs, workers, object storage.
- Java/Spring Boot and PHP via Buildpacks.
- Editable canvas.
- Billing on top of `usage_events` (after a period of reliable data).
- Autoscaling and multi-region based on real demand.

## Phase 5 — Platform

- Template marketplace.
- Webhooks and extensions.
- Import from Heroku/Render/Railway.
- Ephemeral environments for CI.

---

> Estimates assume a team of 3–5 people. With a smaller team, scale down the MVP to Dockerfile + Node and extend Phase 2.
