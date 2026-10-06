# LGPD and terms review

> Status: first slice of Phase 3's "LGPD and terms review" (`docs/roadmap.md`), and the last of
> the four Fase 3 gaps this round of work covers (observability, isolation-in-CI, backup
> restore/runbooks, this one). **This is a technical data-protection review, not legal advice.**
> It maps what personal data the system actually collects and how, and lists the concrete gaps an
> engineer can see from the code. Whether what's described here satisfies LGPD, and the actual
> text of a Privacy Policy / Terms of Service, needs a lawyer — the outline at the bottom is a
> starting point for that conversation, not a substitute for it.

## 1. What personal data exists today, and where

| Data                              | Table / field                                                          | Purpose                                                                        | Notes                                                                                                                                                                                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Email                             | `users.email`                                                          | Identity (login)                                                               | The _only_ identity the platform has — see §3 below, this is also a security finding.                                                                                                                                                                   |
| Name, Browse/IP metadata          | —                                                                      | —                                                                              | Not collected: there's no "name" field on `users`, and request IPs are used only transiently by the rate limiter (`@fastify/rate-limit`), never persisted.                                                                                              |
| Git author name/commit SHA/branch | `deployments.author`, `.commitSha`, `.branch`                          | Shown in the deployments UI, deployment-to-commit linking (architecture.md §8) | `author` is free text pulled from the commit, not validated against the logged-in user — it's whoever's name/email git shows for that commit, which can be a third party who never signed up.                                                           |
| GitHub identity                   | `github_repo_links.installationId`, webhook payloads                   | GitHub App integration                                                         | Installation-scoped, not a personal GitHub account; webhook payloads (`github_webhook_deliveries`) can carry a committer's GitHub login/email as part of the raw payload — see §2.                                                                      |
| Who did what, when                | `audit_logs.actorId` (→ `users.id`), `.action`, `.target`, `.metadata` | Accountability                                                                 | Append-only, no documented retention/purge (see §4).                                                                                                                                                                                                    |
| Variable values                   | `variables.value_enc`                                                  | App configuration                                                              | Envelope-encrypted (`api/src/crypto/envelope.ts`); becomes personal data only if a customer _puts_ personal data in a variable (e.g. a customer's own users' emails in a connection string) — the platform has no visibility into or control over that. |
| Runtime/build logs                | Not yet persisted anywhere (`docs/slos.md`: "No log pipeline")         | Debugging                                                                      | Today's logs only exist transiently (`kubectl logs`, CI output) — nothing durable to apply a retention policy to yet, which is a gap in the other direction (§4).                                                                                       |
| Usage samples                     | `usage_events`                                                         | Future billing (architecture.md §3/§4)                                         | Keyed by project/service, not directly by user.                                                                                                                                                                                                         |
| Billing                           | `invoices`, `invoice_line_items`, `organization_subscriptions`         | Billing                                                                        | No separate "billing contact" personal data beyond the organization relationship — no payment card data stored (architecture.md doesn't describe a payment processor integration yet either).                                                           |

## 2. Data flows worth naming explicitly

- **GitHub → platform**: webhook payloads (`push`, `pull_request`, etc.) are stored in
  `github_webhook_deliveries` and can carry committer names/emails as part of GitHub's own
  payload. There's no filtering/redaction of personal data out of a stored webhook payload today.
- **Platform → GitHub**: check runs and deployment statuses posted back (architecture.md §8) —
  outbound, carries no additional personal data beyond what GitHub already has.
- **Platform → third party (outbound webhooks, roadmap Phase 5)**: `webhook_subscriptions` lets an
  organization configure its own delivery URL; whatever event payload goes out
  (`workers/src/webhooks/deliver.ts`) could carry personal data (deployment author, for instance)
  to a destination the platform doesn't control. This is the customer's own integration, but it's
  still the platform doing the sending.

## 3. Security finding directly relevant to LGPD (Art. 46, security measures)

**Login is email-only, with no verification** (`api/src/auth/local.ts`, `api/src/routes/auth.ts`):
`POST /v1/auth/login` with _any_ email creates-or-finds that user and issues a valid API token —
no password, magic link, or OTP. Anyone who knows (or guesses) a user's email can log in as them
and reach everything in that organization. This is explicitly flagged in the code as an MVP stand-in
(architecture.md: "External provider in the MVP" for Auth; roadmap.md Phase 0: "Out of scope for
this phase: authentication... returns in Phase 1") — but as shipped, it is a live access-control
gap, not a planning placeholder. Treat this as the single highest-priority finding in this review:
LGPD Art. 46 requires technical measures to protect personal data from unauthorized access, and
this authentication scheme doesn't provide that. Fixing it is an engineering task (real auth: a
verified login flow, before anything in §5's recommendations matters).

## 4. Data subject rights: what's implemented

- **Access / portability**: no "export my data" endpoint. A user can see what's visible through
  the normal API, but there's no single "here is everything about you" export.
- **Erasure ("right to be forgotten")**: `architecture.md` §4 says "Soft delete for projects and
  services" — there is no equivalent for `users` themselves. A user has no way to have their
  account, email, or audit-log attribution removed; soft-deleted projects/services still carry
  their data (and whatever personal data is in `deployments.author` or variable values) rather
  than being purged after a grace period.
- **Rectification**: no endpoint to change a user's own email once set.
- **Retention limits**: nothing expires `audit_logs`, `usage_events`, `deployment_events`, or
  `github_webhook_deliveries` — architecture.md §9 mentions "Retention by plan" for _logs_
  specifically (which, per §1 above, aren't persisted yet at all), but nothing in the schema or
  workers enforces a retention window on the tables that already exist and already accumulate.

## 5. Data residency

`regions` (migration 0012, `DEFAULT_REGION_ID`) exists and `POST /v1/projects` accepts a
`regionId` — the mechanism for "this project's data stays in region X" is there. But:
`docs/roadmap.md`'s "Decisions to make before Phase 1" still lists **"Cloud and region: São Paulo
(latency and LGPD) or global from the start"** as an open, undecided question. LGPD doesn't
strictly require in-country storage the way some other regimes do, but the project's own docs
already connect this decision to LGPD specifically — so closing it (even just "we default new
organizations to a São Paulo region") is a prerequisite for anything in this review to mean much
in practice, not an independent nice-to-have.

## 6. Recommendations, in priority order

1. **Fix authentication (§3).** Everything else here assumes an account actually belongs to the
   person who controls it.
2. **Decide the region question (§5)** that `docs/roadmap.md` has left open since before Phase 1.
3. **Add a retention policy and a purge job** for `audit_logs`, `usage_events`,
   `github_webhook_deliveries`, `deployment_events` — "append-only forever" is the current
   default by omission, not a decision anyone made.
4. **Add account deletion** (a real purge path for `users`, not just the existing soft-delete
   pattern for projects/services) before this is needed for a real request.
5. **Write the actual Privacy Policy / Terms of Service** — see the outline below — and decide
   where/how a user accepts them (there's no acceptance flow or stored consent today; `POST
/v1/auth/login` creates a user with no terms-acceptance step at all).

## 7. Terms of Service / Privacy Policy — starting outline (not legal text)

This is a section list to hand to counsel, built from what the previous sections found — not
wording to publish as-is.

**Terms of Service**

- Service description and acceptable use (ties to `architecture.md` §12 #12, abuse).
- Account eligibility and the (to-be-fixed) authentication requirement.
- Customer data: who owns data a customer stores in variables/volumes (the customer, with the
  platform as processor) vs. operational data the platform generates about them (§1).
- Service levels / disclaimers — once `docs/slos.md`'s SLOs are validated against real traffic,
  not before.
- Termination and data deletion on account closure (ties to §4's missing erasure path).

**Privacy Policy**

- What's collected: §1's table, in plain language.
- Why (legal basis per LGPD Art. 7): account email — contract performance; audit logs — legitimate
  interest/security; usage events — contract performance (future billing).
- Who it's shared with: GitHub (by the customer's own choice, installing the App), and any
  third-party webhook destination the customer themselves configures (§2) — the platform doesn't
  sell or independently share data.
- Retention: pending §6 item 3 being implemented — don't publish a retention claim the system
  doesn't yet enforce.
- Data subject rights and how to exercise them: pending §6 items 3–4 existing as real endpoints,
  not just a policy promise with no mechanism behind it.
- Region/residency: pending §5's decision.
- Contact / DPO, if the organization needs one under LGPD's criteria — a legal, not technical,
  determination.
