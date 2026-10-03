import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Banco dedicado, separado do da API: as duas suítes podem rodar em paralelo.
    env: {
      WORKERS_TEST_DATABASE_URL:
        process.env.WORKERS_TEST_DATABASE_URL ?? "postgres://railway:railway@localhost:5432/railway_like_workers_test",
    },
    // Os testes de integração compartilham o banco entre arquivos: rodam em série.
    fileParallelism: false,
    include: ["src/**/*.test.ts"],
  },
});
