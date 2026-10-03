import Fastify from "fastify";
import { ZodError } from "zod";
import { authenticate } from "./auth.js";
import { ApiError } from "./errors.js";
import type { Db } from "./db/client.js";
import { organizationRoutes } from "./routes/organizations.js";
import { projectRoutes } from "./routes/projects.js";

export function buildApp(db: Db, opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? false });

  app.get("/health", async () => ({ status: "ok" }));

  // Tudo em /v1 exige token; o hook fica restrito a este escopo encapsulado.
  app.register(
    async (v1) => {
      v1.addHook("onRequest", authenticate(db));
      await v1.register(organizationRoutes, { db });
      await v1.register(projectRoutes, { db });
    },
    { prefix: "/v1" },
  );

  app.setErrorHandler((err, request, reply) => {
    const problem = toProblem(err, request.url);
    if (problem.status >= 500) request.log.error(err);
    return reply.code(problem.status).type("application/problem+json").send(problem);
  });

  return app;
}

// Erros no formato RFC 9457 (problem+json), com `code` estável para o cliente.
function toProblem(err: unknown, instance: string) {
  if (err instanceof ApiError) {
    return { type: "about:blank", title: err.code, status: err.status, detail: err.message, code: err.code, instance };
  }
  if (err instanceof ZodError) {
    return {
      type: "about:blank",
      title: "validation_failed",
      status: 400,
      detail: "Corpo ou parâmetros inválidos.",
      code: "validation_failed",
      instance,
      errors: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    };
  }
  const fastifyErr = err as { statusCode?: number; code?: string; message?: string };
  if (fastifyErr.statusCode && fastifyErr.statusCode < 500) {
    return {
      type: "about:blank",
      title: fastifyErr.code ?? "bad_request",
      status: fastifyErr.statusCode,
      detail: fastifyErr.message,
      code: fastifyErr.code ?? "bad_request",
      instance,
    };
  }
  return { type: "about:blank", title: "internal_error", status: 500, detail: "Erro interno.", code: "internal_error", instance };
}
