# Runbook: abuse (mining, spam, resource exhaustion)

**Risk:** architecture.md §12 #12 (High). An organization's workloads are being used for
cryptomining, spam, scanning, or otherwise abusing shared platform resources.

## What's already in place

- **Creation quotas** (`api/src/quota.ts`): `MAX_PROJECTS_PER_ORGANIZATION` (20),
  `MAX_SERVICES_PER_PROJECT` (50), `MAX_ENVIRONMENTS_PER_PROJECT` (10). Fixed constants today, not
  configurable per organization — so raising a legitimate customer's limit and throttling an
  abusive one both require a code change, not an admin toggle.
- **Per-token/per-IP rate limiting** (`api/src/app.ts`, `@fastify/rate-limit`): default 300
  requests/minute per authenticated user (or per IP for unauthenticated routes), tighter on login
  (10/minute) to slow brute-force/enumeration. `RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MS` env vars.
- **Per-environment `ResourceQuota`/`LimitRange`** (architecture.md §6/§7.2,
  `workers/src/provisioning/saga.ts`): CPU/memory ceilings per environment at the Kubernetes level
  — this is what actually bounds a single workload's resource consumption once it's running,
  independent of anything at the API layer.
- **No account-level suspend.** There is no "disable this organization" flag or endpoint. See
  `docs/runbooks/README.md`'s "No kill switch yet" note — this is the biggest gap for this runbook
  specifically, since the normal first move in an abuse incident (stop the account from doing
  anything else) doesn't exist as a single action yet.

## Symptoms

- Sustained high CPU/network on a workload with no legitimate traffic explanation (check
  `GET /v1/services/{instanceId}/metrics`).
- A burst of project/service/environment creation from one organization approaching the quota
  ceilings above — abusive automation usually hits a quota wall and then retries, which is visible
  as 403 `quota_exceeded` responses clustering around one `organizationId` in the audit log or
  rate-limiter logs.
- Outbound traffic from a workload to IPs/ports with no relation to the declared app (crypto pool
  ports, SMTP for spam) — the default-deny NetworkPolicy (architecture.md §7.2) limits *inbound*
  cross-environment traffic but still allows broad internet egress by default, which is exactly
  what makes a workload usable for mining/spam in the first place.

## Immediate containment

1. **Scale the offending workload to zero** — the fastest way to actually stop it, since there's
   no suspend flag:
   ```bash
   kubectl --context <ctx> -n env-<environmentId> scale deploy <workload-name> --replicas=0
   ```
   This is a stronger, more disruptive action than anything the API offers today (it bypasses the
   reconciler, which will try to converge the workload back to its desired replica count on the
   next reconcile — so this is a stopgap, not a fix, and needs a real decision from whoever owns
   the account, not just a scale-to-zero left in place indefinitely).
2. **Tighten egress for the affected namespace specifically**, if the abuse is network-based and
   scaling to zero isn't acceptable (e.g. a shared environment with other, legitimate workloads):
   add a namespace-scoped `NetworkPolicy` blocking the specific destination, on top of the
   existing default-deny.
3. **Audit-log the organization's recent activity**
   (`GET /v1/organizations/{organizationId}/audit-logs`) to scope how far the abuse goes — one
   workload, or the whole account.

## Resolution

- Without a suspend mechanism, "resolved" today means: offending workload stopped, and a human
  decision made about the account (warn, keep disabled by leaving replicas at 0, or — since
  there's no deletion-with-ban concept either — manually removing the organization's access some
  other way). This is unsatisfying and is the clearest action item this runbook produces: **build
  the suspend mechanism** before the next real abuse incident, rather than improvising containment
  by hand again.

## Postmortem

Record: how the abuse was first noticed (which signal — quota 403s, metrics, network), how long
it ran before containment, and whether the fixed quota constants in `api/src/quota.ts` would have
caught it sooner if they were lower (or did catch it, if the burst-and-retry pattern shows up in
the audit log as expected).
