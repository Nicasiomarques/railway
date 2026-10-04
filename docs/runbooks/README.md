# Incident runbooks

> Status: first slice of Phase 3's "incident runbooks" (`docs/roadmap.md`). Covers the risks in
> `architecture.md` §12 that are concrete enough today to write real steps for. What each one
> doesn't cover yet is listed inline — this is operational documentation catching up with what's
> implemented, not a claim that every risk is handled.

## Before you start

- **Labels.** Every cluster resource this platform creates carries `platform/project`,
  `platform/env` (environment id) and `platform/instance` or `platform/workload` (architecture.md
  §6). Filter by these, not by name guessing:
  ```bash
  kubectl --context <ctx> get pods -A -l platform/project=<project-id>
  kubectl --context <ctx> get pods -n env-<environment-id>
  ```
- **Audit log.** `GET /v1/organizations/{organizationId}/audit-logs` (most recent first) is the
  first stop for "who did what, when" — it already records volume creation, backup/restore
  triggers, and more (`grep -rn "auditLogs" api/src/routes` for the full list of actions logged).
- **No kill switch yet.** There is no "suspend this organization/project" endpoint or flag in the
  schema. Containment below works at the Kubernetes-resource level (delete/scale/cordon), not by
  flipping a status in the platform's own data model. Adding one is a gap, not covered by this PR.
- **No on-call paging integration.** These runbooks assume a human already knows something is
  wrong (an alert once `docs/slos.md`'s scrape/alerting gap is closed, or a direct report) and is
  working the incident by hand.

## Index

| Runbook | Risk (architecture.md §12) |
|---|---|
| [build-sandbox-escape.md](build-sandbox-escape.md) | #1 Build code escaping the sandbox (Critical) |
| [secrets-leakage.md](secrets-leakage.md) | #2 Secrets leakage (Critical) |
| [backup-restore.md](backup-restore.md) | #9 Insufficient Postgres/Redis backup (Critical) |
| [cluster-or-runtime-unavailable.md](cluster-or-runtime-unavailable.md) | #6 Desired state diverging from actual (High) |
| [abuse.md](abuse.md) | #12 Abuse: mining, spam (High) |

Each runbook ends with a "postmortem" pointer: there's no incident-tracking tool wired up yet, so
for now that means writing the account of what happened in `docs/` (or the project's actual issue
tracker, once one is in scope) rather than losing it.
