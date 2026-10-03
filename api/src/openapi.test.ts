import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { testKeyring } from "./crypto/testing.js";
import { db } from "./db/client.js";
import { registerOpenApi } from "./openapi/index.js";

const app = buildApp(db, { keyring: testKeyring() });

type Doc = {
  servers: { url: string }[];
  openapi: string;
  paths: Record<string, Record<string, any>>;
};

async function loadDoc(): Promise<Doc> {
  const res = await app.inject({ method: "GET", url: "/openapi.json" });
  expect(res.statusCode).toBe(200);
  return res.json();
}

const operations = (doc: Doc) =>
  Object.entries(doc.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, op]) => ({ path, method, op })),
  );

describe("OpenAPI contract", () => {
  it("is published without a token and in OpenAPI 3.1", async () => {
    const doc = await loadDoc();
    expect(doc.openapi).toBe("3.1.0");
  });

  it("describes all 27 operations of the v1 API", async () => {
    const doc = await loadDoc();
    const ops = operations(doc);
    expect(ops).toHaveLength(27);
    expect(ops.map((o) => `${o.method} ${o.path}`).sort()).toEqual(
      [
        "post /v1/auth/login",
        "delete /v1/projects/{projectId}/connections",
        "post /v1/deployments/{deploymentId}/cancel",
        "post /v1/deployments/{deploymentId}:rollback",
        "get /v1/deployments/{deploymentId}/logs",
        "get /v1/deployments/{deploymentId}",
        "get /v1/services/{instanceId}/deployments",
        "get /v1/services/{instanceId}/metrics",
        "post /v1/services/{instanceId}/deployments",
        "delete /v1/services/{instanceId}/variables/{key}",
        "post /v1/github/webhooks",
        "get /v1/organizations",
        "get /v1/organizations/{organizationId}/audit-logs",
        "get /v1/projects",
        "get /v1/projects/{projectId}/connections",
        "get /v1/projects/{projectId}/environments",
        "get /v1/projects/{projectId}/services",
        "get /v1/services/{instanceId}/env",
        "get /v1/services/{instanceId}/variables",
        "post /v1/organizations",
        "post /v1/projects",
        "post /v1/projects/{projectId}/connections",
        "post /v1/projects/{projectId}/services",
        "put /v1/services/{instanceId}/variables/{key}",
        "post /v1/services/{instanceId}/domains",
        "get /v1/services/{instanceId}/domains",
        "delete /v1/services/{instanceId}/domains/{domainId}",
        "post /v1/services/{instanceId}/volumes",
        "get /v1/services/{instanceId}/volumes",
        "post /v1/volumes/{volumeId}/backup",
      ].sort(),
    );
  });

  it("operationId is unique", async () => {
    const ids = operations(await loadDoc()).map((o) => o.op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every operation requires bearer and documents 401", async () => {
    for (const { op } of operations(await loadDoc())) {
      expect(op.security).toEqual([{ bearerAuth: [] }]);
      expect(op.responses["401"]).toBeDefined();
    }
  });

  it("body comes from the Zod schema, with required fields", async () => {
    const doc = await loadDoc();
    const body = doc.paths["/v1/organizations"].post.requestBody.content["application/json"].schema;
    expect(body.required).toContain("name");
    expect(body.properties.name.minLength).toBe(1);
  });

  it("path and query parameters come from the schemas", async () => {
    const doc = await loadDoc();
    const list = doc.paths["/v1/projects"].get.parameters;
    expect(list).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "organizationId", in: "query", required: true })]),
    );
    const services = doc.paths["/v1/projects/{projectId}/services"].get.parameters;
    expect(services).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "projectId", in: "path", required: true })]),
    );
  });

  it("idempotent POSTs declare the Idempotency-Key header", async () => {
    const doc = await loadDoc();
    const header = doc.paths["/v1/projects"].post.parameters.find((p: any) => p.name === "Idempotency-Key");
    expect(header).toMatchObject({ in: "header", required: false });
  });

  it("error responses use problem+json", async () => {
    const doc = await loadDoc();
    const err = doc.paths["/v1/projects"].post.responses["409"];
    expect(err.content["application/problem+json"]).toBeDefined();
  });

  it("DELETE with 204 has no response body", async () => {
    const doc = await loadDoc();
    expect(doc.paths["/v1/services/{instanceId}/variables/{key}"].delete.responses["204"]).toEqual({
      description: "Variable removed",
    });
  });

  it("does not allow a /v1 route to start without OpenAPI metadata", async () => {
    const bare = Fastify();
    registerOpenApi(bare, { version: "test" });
    bare.get("/v1/no-metadata", async () => ({}));
    await expect(bare.ready()).rejects.toThrow(/GET \/v1\/no-metadata/);
  });
});

describe("Stoplight documentation", () => {
  it("GET /docs returns the Elements page pointing to /openapi.json, without a token", async () => {
    const res = await app.inject({ method: "GET", url: "/docs" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain('<elements-api apiDescriptionUrl="/openapi.json"');
  });

  it("serves the Elements bundle at /docs/assets", async () => {
    const js = await app.inject({ method: "GET", url: "/docs/assets/web-components.min.js" });
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toContain("javascript");
    expect(js.body.length).toBeGreaterThan(10_000);

    const css = await app.inject({ method: "GET", url: "/docs/assets/styles.min.css" });
    expect(css.statusCode).toBe(200);
    expect(css.headers["content-type"]).toContain("text/css");
  });

  it("does not expose other files from the package", async () => {
    for (const file of ["package.json", "../package.json", "index.js"]) {
      const res = await app.inject({ method: "GET", url: `/docs/assets/${file}` });
      expect(res.statusCode).toBe(404);
    }
  });
});

describe("contract server", () => {
  it("the base URL is the root, because the paths already carry /v1", async () => {
    const doc = await loadDoc();
    expect(doc.servers).toEqual([{ url: "/" }]);
  });
});
