import { db } from "./client.js";
import { createUserWithToken } from "./fixtures.js";

// Uso: `pnpm db:seed`. Imprime um token de dev para usar em `Authorization: Bearer ...`.
const { org, token } = await createUserWithToken(db, "dev");
console.log(`organização: ${org.slug}`);
console.log(`token: ${token}`);
process.exit(0);
