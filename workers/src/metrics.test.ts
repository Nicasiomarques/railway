import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { Job, Worker } from "bullmq";
import { jobDuration, jobsTotal, observeWorker } from "./metrics.js";

// A plain EventEmitter is enough: observeWorker only calls `.on("completed" | "failed", ...)`.
function fakeWorker(): Worker {
  return new EventEmitter() as unknown as Worker;
}

function fakeJob(overrides: Partial<Job> = {}): Job {
  const processedOn = Date.now() - 1000;
  return { name: "test-job", processedOn, finishedOn: processedOn + 1000, ...overrides } as Job;
}

describe("observeWorker", () => {
  it("counts a completed job under outcome=completed", async () => {
    const worker = fakeWorker();
    observeWorker(worker, "test-queue");

    worker.emit("completed", fakeJob({ name: "my-job" }));

    const counter = (await jobsTotal.get()).values.find(
      (v) => v.labels.job_name === "my-job" && v.labels.outcome === "completed",
    );
    expect(counter?.value).toBe(1);

    const duration = (await jobDuration.get()).values.find(
      (v) =>
        v.labels.job_name === "my-job" &&
        v.labels.outcome === "completed" &&
        "le" in v.labels &&
        v.labels.le === "+Inf",
    );
    expect(duration?.value).toBe(1);
  });

  it("counts a failed job under outcome=failed, even with no finishedOn yet", async () => {
    const worker = fakeWorker();
    observeWorker(worker, "test-queue");

    worker.emit("failed", fakeJob({ name: "flaky-job", finishedOn: undefined }));

    const before = (await jobsTotal.get()).values.find(
      (v) => v.labels.job_name === "flaky-job" && v.labels.outcome === "failed",
    );
    expect(before?.value).toBe(1);
  });
});
