import { Worker } from "bullmq";
import { Redis } from "ioredis";

const connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

new Worker(
  "deployments",
  async (job) => {
    console.log(`job ${job.id} recebido`, job.name);
  },
  { connection },
);

console.log("workers iniciados");
