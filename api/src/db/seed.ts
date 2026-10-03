import { db } from "./client.js";
import { createUserWithToken } from "./fixtures.js";

// Usage: `pnpm db:seed`. Prints a dev token to use in `Authorization: Bearer ...`.
const { org, token } = await createUserWithToken(db, "dev");
console.log(`organization: ${org.slug}`);
console.log(`token: ${token}`);
process.exit(0);
