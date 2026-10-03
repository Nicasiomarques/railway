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

describe("contrato OpenAPI", () => {
  it("é publicado sem token e em OpenAPI 3.1", async () => {
    const doc = await loadDoc();
    expect(doc.openapi).toBe("3.1.0");
  });

  it("descreve todas as 20 operações da API v1", async () => {
    const doc = await loadDoc();
    const ops = operations(doc);
    expect(ops).toHaveLength(20);
    expect(ops.map((o) => `${o.method} ${o.path}`).sort()).toEqual(
      [
        "delete /v1/projects/{projectId}/connections",
        "post /v1/deployments/{deploymentId}/cancel",
        "get /v1/deployments/{deploymentId}/logs",
        "get /v1/deployments/{deploymentId}",
        "get /v1/services/{instanceId}/deployments",
        "get /v1/services/{instanceId}/metrics",
        "post /v1/services/{instanceId}/deployments",
        "delete /v1/services/{instanceId}/variables/{key}",
        "get /v1/organizations",
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
      ].sort(),
    );
  });

  it("operationId é único", async () => {
    const ids = operations(await loadDoc()).map((o) => o.op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("toda operação exige bearer e documenta 401", async () => {
    for (const { op } of operations(await loadDoc())) {
      expect(op.security).toEqual([{ bearerAuth: [] }]);
      expect(op.responses["401"]).toBeDefined();
    }
  });

  it("corpo vem do schema Zod, com campos obrigatórios", async () => {
    const doc = await loadDoc();
    const body = doc.paths["/v1/organizations"].post.requestBody.content["application/json"].schema;
    expect(body.required).toContain("name");
    expect(body.properties.name.minLength).toBe(1);
  });

  it("parâmetros de caminho e query saem dos schemas", async () => {
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

  it("POSTs idempotentes declaram o header Idempotency-Key", async () => {
    const doc = await loadDoc();
    const header = doc.paths["/v1/projects"].post.parameters.find((p: any) => p.name === "Idempotency-Key");
    expect(header).toMatchObject({ in: "header", required: false });
  });

  it("respostas de erro usam problem+json", async () => {
    const doc = await loadDoc();
    const err = doc.paths["/v1/projects"].post.responses["409"];
    expect(err.content["application/problem+json"]).toBeDefined();
  });

  it("DELETE com 204 não tem corpo de resposta", async () => {
    const doc = await loadDoc();
    expect(doc.paths["/v1/services/{instanceId}/variables/{key}"].delete.responses["204"]).toEqual({
      description: "Variável removida",
    });
  });

  it("não deixa subir uma rota /v1 sem metadado OpenAPI", async () => {
    const bare = Fastify();
    registerOpenApi(bare, { version: "test" });
    bare.get("/v1/sem-metadado", async () => ({}));
    await expect(bare.ready()).rejects.toThrow(/GET \/v1\/sem-metadado/);
  });
});

describe("documentação Stoplight", () => {
  it("GET /docs devolve a página do Elements apontando para /openapi.json, sem token", async () => {
    const res = await app.inject({ method: "GET", url: "/docs" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain('<elements-api apiDescriptionUrl="/openapi.json"');
  });

  it("serve o bundle do Elements em /docs/assets", async () => {
    const js = await app.inject({ method: "GET", url: "/docs/assets/web-components.min.js" });
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toContain("javascript");
    expect(js.body.length).toBeGreaterThan(10_000);

    const css = await app.inject({ method: "GET", url: "/docs/assets/styles.min.css" });
    expect(css.statusCode).toBe(200);
    expect(css.headers["content-type"]).toContain("text/css");
  });

  it("não expõe outros arquivos do pacote", async () => {
    for (const file of ["package.json", "../package.json", "index.js"]) {
      const res = await app.inject({ method: "GET", url: `/docs/assets/${file}` });
      expect(res.statusCode).toBe(404);
    }
  });
});

describe("servidor do contrato", () => {
  it("a URL base é a raiz, porque os paths já trazem /v1", async () => {
    const doc = await loadDoc();
    expect(doc.servers).toEqual([{ url: "/" }]);
  });
});
