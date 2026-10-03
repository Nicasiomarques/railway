import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Banco separado do de dev; ver README. Testes rodam em série e compartilham o mesmo DB.
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://railway:railway@localhost:5432/railway_like_test",
    },
    fileParallelism: false,
    include: ["src/**/*.test.ts"],
  },
});
