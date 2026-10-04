import type { FastifyInstance } from "fastify";
import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";

// Phase 3 (docs/roadmap.md) / architecture.md §9 ("Platform: ... deploy-time and build-time
// SLOs"): this is the first slice of that — HTTP-level SLIs for the API process. See
// docs/slos.md for the SLOs defined on top of these series.
export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of API requests, labeled by method, route and status code.",
  labelNames: ["method", "route", "status_code"] as const,
  // Covers both the fast CRUD paths and the long tail of synchronous DB-bound ones; deploy-time
  // enqueue is 202-and-done, not request-bound, so it isn't represented here. See workers/src/metrics.ts.
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total API requests, labeled by method, route and status code.",
  labelNames: ["method", "route", "status_code"] as const,
  registers: [registry],
});

// `request.routeOptions.url` is the registered pattern (e.g. "/v1/projects/:project"), not the
// raw URL -- using the raw URL would blow up cardinality with one series per project id.
//
// Timed by hand with `process.hrtime.bigint()` (onRequest -> onResponse) rather than relying on a
// Fastify-version-specific reply timer, so this doesn't break across a Fastify upgrade.
export function registerMetrics(app: FastifyInstance): void {
  app.addHook("onRequest", async (request) => {
    (request as { metricsStart?: bigint }).metricsStart = process.hrtime.bigint();
  });

  app.addHook("onResponse", async (request, reply) => {
    const start = (request as { metricsStart?: bigint }).metricsStart;
    const durationSeconds = start ? Number(process.hrtime.bigint() - start) / 1e9 : 0;
    const route = request.routeOptions?.url ?? "unmatched";
    const labels = { method: request.method, route, status_code: String(reply.statusCode) };
    httpRequestDuration.observe(labels, durationSeconds);
    httpRequestsTotal.inc(labels);
  });

  // Unauthenticated and outside /v1 on purpose, same reasoning as /health: a scrape has no API
  // token, and exposing request-rate/latency series isn't a tenant-data leak.
  app.get("/metrics", async (_request, reply) => {
    reply.type(registry.contentType);
    return registry.metrics();
  });
}
