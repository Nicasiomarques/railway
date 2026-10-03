import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "../db/src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://railway:railway@localhost:5432/railway_like",
  },
});
