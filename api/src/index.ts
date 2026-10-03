import { buildApp } from "./app.js";
import { loadKeyringFromEnv } from "./crypto/envelope.js";
import { db } from "./db/client.js";
import { createDeploymentQueue } from "./queue.js";

if (!process.env.REDIS_URL) throw new Error("REDIS_URL is required: the API enqueues deployments in Redis.");

const queue = createDeploymentQueue(process.env.REDIS_URL);
const app = buildApp(db, { keyring: loadKeyringFromEnv(), logger: true, queue });
const port = Number(process.env.PORT ?? 3000);

await app.listen({ port, host: "0.0.0.0" });

async function shutdown(): Promise<void> {
  await app.close();
  await queue.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
