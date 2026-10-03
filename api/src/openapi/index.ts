import type { FastifyInstance } from "fastify";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ZodType } from "zod";
import { ProblemSchema } from "./schemas.js";

// Metadado de documentação por rota. Vive ao lado de cada `app.<método>(...)`, em `config.openapi`.
// Método e caminho vêm do próprio Fastify, então não há como o contrato divergir das rotas.
// Os schemas são `unknown` aqui: tipá-los como ZodType quebra a inferência do `config` da rota.
// toJsonSchema valida em runtime que cada um é um schema Zod.
export interface OperationMeta {
  operationId: string;
  tags: string[];
  summary: string;
  pathSchema?: unknown;
  querySchema?: unknown;
  bodySchema?: unknown;
  // Header Idempotency-Key opcional (POSTs que criam recursos ou disparam jobs).
  idempotent?: boolean;
  success: { status: number; description: string; schema?: unknown };
  // Códigos de erro que a operação pode devolver além de 401 (todas exigem token).
  errors?: number[];
}

declare module "fastify" {
  interface FastifyContextConfig {
    openapi?: OperationMeta;
  }
}

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: "Entrada inválida",
  401: "Token ausente ou inválido",
  403: "Sem permissão para esta ação",
  404: "Recurso não encontrado",
  409: "Conflito com o estado atual",
  422: "Regra de negócio violada",
};

interface CollectedRoute {
  method: string;
  url: string;
  meta: OperationMeta | undefined;
}

const API_PREFIX = "/v1";

// Converte o schema Zod em JSON Schema inline (sem $ref), para o documento ser autocontido.
function toJsonSchema(schema: unknown): Record<string, unknown> {
  if (!(schema instanceof ZodType)) throw new Error("Metadado OpenAPI espera um schema Zod");
  const { $schema: _ignored, ...json } = zodToJsonSchema(schema, {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;
  return json;
}

function objectProperties(schema: unknown, location: "path" | "query") {
  if (!schema) return [];
  const json = toJsonSchema(schema) as { properties?: Record<string, unknown>; required?: string[] };
  const required = new Set(json.required ?? []);
  return Object.entries(json.properties ?? {}).map(([name, prop]) => ({
    name,
    in: location,
    required: location === "path" || required.has(name),
    schema: prop,
  }));
}

function toOpenApiPath(url: string): string {
  return url.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

export function buildOpenApiDocument(routes: CollectedRoute[], version: string) {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    const meta = route.meta!;
    const path = toOpenApiPath(route.url);
    const parameters: unknown[] = [...objectProperties(meta.pathSchema, "path"), ...objectProperties(meta.querySchema, "query")];
    if (meta.idempotent) {
      parameters.push({
        name: "Idempotency-Key",
        in: "header",
        required: false,
        description: "Chave para repetir a operação sem efeito duplicado (1 a 255 caracteres).",
        schema: { type: "string", minLength: 1, maxLength: 255 },
      });
    }

    const responses: Record<string, unknown> = {
      [meta.success.status]: meta.success.schema
        ? {
            description: meta.success.description,
            content: { "application/json": { schema: toJsonSchema(meta.success.schema) } },
          }
        : { description: meta.success.description },
    };
    const hasInput = Boolean(meta.pathSchema || meta.querySchema || meta.bodySchema);
    const errorStatuses = new Set([401, ...(hasInput ? [400] : []), ...(meta.errors ?? [])]);
    for (const status of errorStatuses) {
      responses[status] = {
        description: ERROR_DESCRIPTIONS[status] ?? "Erro",
        content: { "application/problem+json": { schema: toJsonSchema(ProblemSchema) } },
      };
    }

    const operation: Record<string, unknown> = {
      operationId: meta.operationId,
      tags: meta.tags,
      summary: meta.summary,
      security: [{ bearerAuth: [] }],
      parameters,
      responses,
    };
    if (meta.bodySchema) {
      operation.requestBody = {
        required: true,
        content: { "application/json": { schema: toJsonSchema(meta.bodySchema) } },
      };
    }

    paths[path] = { ...paths[path], [route.method.toLowerCase()]: operation };
  }

  return {
    openapi: "3.1.0",
    info: { title: "Railway-like API", version },
    // Os paths já trazem o prefixo /v1; o servidor é a raiz, senão clientes gerados chamariam /v1/v1/...
    servers: [{ url: "/" }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "Token de API com escopo e expiração." },
      },
    },
    paths,
  };
}

// Coleta as rotas /v1 à medida que são registradas, valida que todas têm metadado e publica o contrato em /openapi.json.
export function registerOpenApi(app: FastifyInstance, opts: { version: string }): void {
  const routes: CollectedRoute[] = [];
  let document: ReturnType<typeof buildOpenApiDocument> | undefined;

  // Precisa ser registrado antes das rotas: hooks de onRoute no root valem para os escopos filhos.
  app.addHook("onRoute", (route) => {
    if (route.method === "HEAD" || !route.url.startsWith(API_PREFIX)) return;
    routes.push({ method: String(route.method), url: route.url, meta: route.config?.openapi });
  });

  app.addHook("onReady", async () => {
    const missing = routes.filter((r) => !r.meta).map((r) => `${r.method} ${r.url}`);
    if (missing.length > 0) {
      throw new Error(`Rotas sem metadado OpenAPI (config.openapi): ${missing.join(", ")}`);
    }
    document = buildOpenApiDocument(routes, opts.version);
  });

  app.get("/openapi.json", async () => document);
}
