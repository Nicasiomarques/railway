# Runbook: secrets leakage

**Risk:** architecture.md §12 #2 (Critical). A secret variable (`is_secret` on the `variables`
table) ends up somewhere it shouldn't: a log line, a fork PR's build, a response body, a committed
file.

## Symptoms

- A secret value appears in build logs, runtime logs, an API response, or a GitHub PR/comment.
- A fork PR's build received secrets it shouldn't have (architecture.md §8: "Fork PRs do not
  receive secrets and are blocked by default" — if this happened, the block itself failed).
- A user reports a credential (DB password, API key) they stored as a Railway-like variable no
  longer looks private, or was used from somewhere unexpected.

## Immediate containment

1. **Rotate the leaked value first, at its source.** This platform stores the secret, it doesn't
   issue it — so rotation happens with whoever issued the credential (the database, the external
   API, etc.), not here. Do this before anything else; every minute the old value stays valid is a
   minute it's still usable by whoever has it.
2. **Update the variable to the new value**, scoped correctly (service-instance, environment, or
   project — architecture.md §4):
   ```
   PUT /v1/services/{instanceId}/variables/{key}
   ```
   This creates a new `EnvSnapshot` on the next deploy — rollback to a deployment *before* the
   rotation will restore the **old, now-rotated** value, since snapshots are immutable by design
   (architecture.md §4). Account for that before rolling back anything while responding to this
   incident.
3. **Trigger a redeploy** of every service instance using that variable, so the running workload
   actually picks up the new value (a `PUT` alone doesn't touch a workload already running — same
   as any other variable change).
4. **If the leak was in logs**: there's no log-redaction or retention-purge tool today (log
   storage itself is still a gap — see `docs/slos.md`'s "No log pipeline" line). For now this means
   manually locating and purging the affected log lines wherever they're currently captured
   (`kubectl logs`, CI job output, GitHub Actions logs for a fork-PR leak), and tracking the gap of
   not being able to do this systematically as a follow-up.

## Diagnosis

- Pull the audit log for the affected organization (`GET
  /v1/organizations/{organizationId}/audit-logs`) around the time of the suspected leak — look for
  `variable.*` actions (`grep -n "variable\." api/src/routes/variables.ts`) to establish who
  touched the variable and when.
- If a fork PR received secrets it shouldn't have: check the GitHub App installation's webhook
  handling (`api/src/routes/github.ts`) for whether the fork-PR exclusion (architecture.md §8) was
  actually applied to that specific PR, and whether it's a one-off bug or a systemic hole.
- Confirm the value is actually marked `is_secret: true` going forward — a variable that should
  have been a secret but wasn't is a different, policy-level bug worth fixing, not just rotating
  through.

## Resolution

- Rotation (above) is the actual fix. There is no way to "unsee" a value that already leaked —
  treat every leaked credential as compromised and rotate, full stop, rather than trying to assess
  whether it was "really" exposed.
- If envelope-encryption keys themselves (`ENCRYPTION_KEYS`/`ENCRYPTION_CURRENT_KID`,
  `api/src/crypto/envelope.ts`) are suspected compromised (not an individual variable, but the KEK
  that wraps all of them): add a new `kid` to `ENCRYPTION_KEYS`, set it as
  `ENCRYPTION_CURRENT_KID`, and re-encrypt every secret variable (new writes use the new key
  automatically; existing ciphertexts need an explicit re-encrypt pass — there's no built-in
  "rotate everything now" job for this yet, which is itself a gap worth closing before this is
  needed for real).

## Postmortem

Record: which variable/service/environment, how long the value was exposed, where it leaked
(logs, response, fork build, git history), and whether this runbook's "no log redaction" gap was
the reason containment took longer than it should have.
