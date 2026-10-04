# Observability and SLOs

> Status: first slice of `architecture.md` §9 ("Platform: ... deploy-time and build-time SLOs").
> Covers metrics only — logs (Vector/Fluent Bit → Loki) and traces (OpenTelemetry) from §9 are
> still not implemented; see `docs/roadmap.md` Phase 3.

## What is exported today

| Process | Endpoint | Series |
|---|---|---|
| `api` | `GET /metrics` | `http_request_duration_seconds` (histogram), `http_requests_total` (counter), labeled `method`, `route`, `status_code` |
| `workers` | `GET /metrics` on `METRICS_PORT` (default `9102`) | `job_duration_seconds` (histogram), `jobs_total` (counter), labeled `queue`, `job_name`, `outcome` |

Both also export the default Node.js process metrics (`process_cpu_*`, `process_resident_memory_bytes`, event loop lag, etc.) via `prom-client`'s `collectDefaultMetrics`.

Neither endpoint requires authentication, same as `/health` — a scrape has no API token, and request-rate/latency series aren't tenant data (no project, org or user label is ever attached).

## SLOs defined on top of these series

These are starting targets, not yet validated against production traffic (there is none). Revisit once real usage exists.

| SLI | Query (promql-ish) | Target (SLO) |
|---|---|---|
| API availability | `1 - (sum(rate(http_requests_total{status_code=~"5.."}[5m])) / sum(rate(http_requests_total[5m])))` | 99.5% of requests over any 5 min window are not 5xx |
| API latency | `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))` | p95 < 500ms, excluding `/v1/deployments/:id/logs` (SSE, long-lived by design) |
| Reconcile job success rate | `sum(rate(jobs_total{queue="deployments",job_name="reconcile-instance",outcome="completed"}[1h])) / sum(rate(jobs_total{queue="deployments",job_name="reconcile-instance"}[1h]))` | 99% over any rolling hour |
| Backup success rate | `sum(rate(jobs_total{queue="backups",outcome="completed"}[1d])) / sum(rate(jobs_total{queue="backups"}[1d]))` | 99.9% over any rolling day (architecture.md §12 risk #9: "Insufficient Postgres/Redis backup" is Critical impact) |

"Deploy-time SLO" (§9) is deliberately not `job_duration_seconds` on `reconcile-instance`: a single reconcile attempt's duration isn't the deploy's wall-clock time, since pending states re-enqueue themselves (see `shared/src/jobs.ts`'s `RECONCILE_JOB_RETRY`, up to 240 attempts). Measuring the full `Queued → Running` latency needs a histogram over `DeploymentEvent` timestamps (architecture.md §4), which is not implemented — tracked as a gap below.

## Known gaps (still Phase 3 work, not this change)

- No scrape/alerting infrastructure (Prometheus/VictoriaMetrics server, alertmanager) — these endpoints are ready to be scraped but nothing scrapes them outside a manual `curl` yet.
- No deploy-wall-clock histogram (`Queued` → `Running`, per `DeploymentEvent`).
- No log pipeline (Vector/Fluent Bit → Loki/VictoriaLogs) or OTEL traces, both still in architecture.md §9.
- No dashboards.
