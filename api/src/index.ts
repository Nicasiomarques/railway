import { buildApp } from "./app.js";
import { loadKeyringFromEnv } from "./crypto/envelope.js";
import { db } from "./db/client.js";
import { createBackupQueue, createDeploymentQueue, createDomainQueue } from "./queue.js";

if (!process.env.REDIS_URL) throw new Error("REDIS_URL is required: the API enqueues deployments in Redis.");

const queue = createDeploymentQueue(process.env.REDIS_URL);
const domainQueue = createDomainQueue(process.env.REDIS_URL);
const backupQueue = createBackupQueue(process.env.REDIS_URL);
const app = buildApp(db, {
  keyring: loadKeyringFromEnv(),
  logger: true,
  queue,
  domainQueue,
  backupQueue,
  baseDomain: process.env.APPS_BASE_DOMAIN,
  githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
});
const port = Number(process.env.PORT ?? 3000);

await app.listen({ port, host: "0.0.0.0" });

async function shutdown(): Promise<void> {
  await app.close();
  await queue.close();
  await domainQueue.close();
  await backupQueue.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
