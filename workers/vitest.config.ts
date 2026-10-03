import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Dedicated database, separate from the API's: the two suites can run in parallel.
    env: {
      WORKERS_TEST_DATABASE_URL:
        process.env.WORKERS_TEST_DATABASE_URL ?? "postgres://railway:railway@localhost:5432/railway_like_workers_test",
    },
    // Integration tests share the database across files: they run in series.
    fileParallelism: false,
    include: ["src/**/*.test.ts"],
  },
});
