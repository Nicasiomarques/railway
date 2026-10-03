import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Em dev, a API roda em outra porta; o proxy evita CORS. API_URL troca o alvo (ex.: outra instância local).
    proxy: {
      "/v1": process.env.API_URL ?? "http://localhost:3000",
      "/health": process.env.API_URL ?? "http://localhost:3000",
    },
  },
});
