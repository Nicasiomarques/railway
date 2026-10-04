import { createServer } from "node:http";
import type { Job, Worker } from "bullmq";
import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";

// Phase 3 (docs/roadmap.md) / architecture.md §9 ("Platform: ... deploy-time and build-time
// SLOs"): job-level SLIs for every BullMQ worker this process runs. See docs/slos.md for the
// SLOs defined on top of these series, and api/src/metrics.ts for the HTTP-level counterpart.
export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const jobDuration = new Histogram({
  name: "job_duration_seconds",
  help: "Duration of a BullMQ job from start to completion or failure, labeled by queue, job name and outcome.",
  labelNames: ["queue", "job_name", "outcome"] as const,
  // Most jobs here are either quick DB-bound steps or poll-until-ready loops (reconcile re-enqueues
  // itself rather than blocking, so a single attempt's duration stays in this range even for a
  // multi-minute deploy) — see docs/slos.md for the deploy-wide SLO, which is measured differently.
  buckets: [0.1, 0.5, 1, 5, 15, 30, 60, 300],
  registers: [registry],
});

export const jobsTotal = new Counter({
  name: "jobs_total",
  help: "Total BullMQ jobs processed, labeled by queue, job name and outcome (completed|failed).",
  labelNames: ["queue", "job_name", "outcome"] as const,
  registers: [registry],
});

// Attaches outcome/duration recording to an already-created Worker, without touching its
// processor function. `queueName` is passed explicitly because `Worker` doesn't otherwise expose
// it in a typed way across the versions of bullmq this repo has used.
export function observeWorker(worker: Worker, queueName: string): void {
  worker.on("completed", (job: Job) => {
    const labels = { queue: queueName, job_name: job.name, outcome: "completed" };
    jobsTotal.inc(labels);
    if (job.finishedOn && job.processedOn) jobDuration.observe(labels, (job.finishedOn - job.processedOn) / 1000);
  });

  worker.on("failed", (job: Job | undefined) => {
    const labels = { queue: queueName, job_name: job?.name ?? "unknown", outcome: "failed" };
    jobsTotal.inc(labels);
    if (job?.finishedOn && job.processedOn) jobDuration.observe(labels, (job.finishedOn - job.processedOn) / 1000);
  });
}

// Plain http.Server instead of another Fastify instance: this process has no other HTTP surface,
// and pulling in a whole web framework for one scrape endpoint isn't worth it.
export function startMetricsServer(port: number): { close(): Promise<void> } {
  const server = createServer((req, res) => {
    if (req.url !== "/metrics") {
      res.writeHead(404).end();
      return;
    }
    registry
      .metrics()
      .then((body) => {
        res.writeHead(200, { "content-type": registry.contentType });
        res.end(body);
      })
      .catch((err: unknown) => {
        res.writeHead(500).end(String(err));
      });
  });
  server.listen(port);
  return {
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}
