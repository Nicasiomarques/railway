import { buildApp } from "./app.js";
import { db } from "./db/client.js";

const app = buildApp(db, { logger: true });
const port = Number(process.env.PORT ?? 3000);

await app.listen({ port, host: "0.0.0.0" });
