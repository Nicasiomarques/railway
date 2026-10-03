import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Database separate from the dev one; see README. Tests run in series and share the same DB.
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://railway:railway@localhost:5432/railway_like_test",
    },
    fileParallelism: false,
    include: ["src/**/*.test.ts"],
  },
});
