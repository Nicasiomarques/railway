import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { testKeyring } from "./crypto/testing.js";
import { db } from "./db/client.js";

describe("GET /metrics", () => {
  it("exposes HTTP request metrics in Prometheus text format", async () => {
    const app = buildApp(db, { keyring: testKeyring() });
    try {
      await app.inject({ method: "GET", url: "/health" });

      const res = await app.inject({ method: "GET", url: "/metrics" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/plain");
      expect(res.body).toContain("http_request_duration_seconds");
      expect(res.body).toContain('route="/health"');
    } finally {
      await app.close();
    }
  });

  it("does not require authentication", async () => {
    const app = buildApp(db, { keyring: testKeyring() });
    try {
      const res = await app.inject({ method: "GET", url: "/metrics" });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
