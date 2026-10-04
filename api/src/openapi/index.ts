import type { FastifyInstance } from "fastify";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ZodType } from "zod";
import { ProblemSchema } from "./schemas.js";

// Per-route documentation metadata. Lives next to each `app.<method>(...)`, in `config.openapi`.
// Method and path come from Fastify itself, so the contract can never drift from the routes.
// The schemas are `unknown` here: typing them as ZodType breaks the route's `config` inference.
// toJsonSchema validates at runtime that each one is actually a Zod schema.
export interface OperationMeta {
  operationId: string;
  tags: string[];
  summary: string;
  pathSchema?: unknown;
  querySchema?: unknown;
  bodySchema?: unknown;
  // Optional Idempotency-Key header (POSTs that create resources or trigger jobs).
  idempotent?: boolean;
  success: { status: number; description: string; schema?: unknown };
  // Error codes the operation can return besides 401 (all of them require a token).
  errors?: number[];
}

declare module "fastify" {
  interface FastifyContextConfig {
    openapi?: OperationMeta;
  }
}

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: "Invalid input",
  401: "Missing or invalid token",
  403: "Not allowed to perform this action",
  404: "Resource not found",
  409: "Conflict with the current state",
  422: "Business rule violated",
  429: "Too many requests",
};

interface CollectedRoute {
  method: string;
  url: string;
  meta: OperationMeta | undefined;
}

const API_PREFIX = "/v1";

// Converts the Zod schema into an inline JSON Schema (no $ref), so the document is self-contained.
function toJsonSchema(schema: unknown): Record<string, unknown> {
  if (!(schema instanceof ZodType)) throw new Error("OpenAPI metadata expects a Zod schema");
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

// A route segment can carry a find-my-way regex constraint, e.g. ":deploymentId([^:]+)", and the
// literal API-as-verb convention (architecture.md §10, e.g. "/deployments/{id}:rollback") is written
// in Fastify as ":deploymentId([^:]+)::rollback" — the constraint stops the param from swallowing the
// literal colon, and the doubled "::" is find-my-way's own escape for a single literal ":" in the URL.
// The negative lookbehind keeps that escaped "::" from being mistaken for the start of another param
// (its second colon is never preceded by anything but another colon); the trailing replace then
// collapses the escape down to the single ":" that actually appears in the real URL.
function toOpenApiPath(url: string): string {
  return url.replace(/(?<!:):([A-Za-z0-9_]+)(?:\([^)]*\))?/g, "{$1}").replace(/::/g, ":");
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
        description: "Key to retry the operation without a duplicate effect (1 to 255 characters).",
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
        description: ERROR_DESCRIPTIONS[status] ?? "Error",
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
    // The paths already carry the /v1 prefix; the server is the root, otherwise generated clients would call /v1/v1/...
    servers: [{ url: "/" }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "API token with scope and expiration." },
      },
    },
    paths,
  };
}

// Collects the /v1 routes as they are registered, validates that all of them have metadata, and publishes the contract at /openapi.json.
export function registerOpenApi(app: FastifyInstance, opts: { version: string }): void {
  const routes: CollectedRoute[] = [];
  let document: ReturnType<typeof buildOpenApiDocument> | undefined;

  // Must be registered before the routes: onRoute hooks on the root apply to the child scopes.
  app.addHook("onRoute", (route) => {
    if (route.method === "HEAD" || !route.url.startsWith(API_PREFIX)) return;
    routes.push({ method: String(route.method), url: route.url, meta: route.config?.openapi });
  });

  app.addHook("onReady", async () => {
    const missing = routes.filter((r) => !r.meta).map((r) => `${r.method} ${r.url}`);
    if (missing.length > 0) {
      throw new Error(`Routes missing OpenAPI metadata (config.openapi): ${missing.join(", ")}`);
    }
    document = buildOpenApiDocument(routes, opts.version);
  });

  app.get("/openapi.json", async () => document);
}
