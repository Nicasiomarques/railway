import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In dev, the API runs on a different port; the proxy avoids CORS. API_URL swaps the target (e.g. another local instance).
    proxy: {
      "/v1": process.env.API_URL ?? "http://localhost:3000",
      "/health": process.env.API_URL ?? "http://localhost:3000",
    },
  },
});
