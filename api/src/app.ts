import Fastify from "fastify";
import { ZodError } from "zod";
import { authenticate } from "./auth.js";
import { ApiError } from "./errors.js";
import type { Db } from "./db/client.js";
import { organizationRoutes } from "./routes/organizations.js";
import { projectRoutes } from "./routes/projects.js";
import { environmentRoutes } from "./routes/environments.js";
import { serviceRoutes } from "./routes/services.js";
import { connectionRoutes } from "./routes/connections.js";
import { variableRoutes } from "./routes/variables.js";
import { domainRoutes } from "./routes/domains.js";
import type { Keyring } from "./crypto/envelope.js";
import { registerOpenApi } from "./openapi/index.js";
import { docsRoutes } from "./openapi/docs.js";
import { deploymentRoutes } from "./routes/deployments.js";
import { githubRoutes } from "./routes/github.js";
import type { DeploymentQueue, DomainQueue } from "./queue.js";
import type { GitHubChecksClient, GitHubInstallationTokenClient } from "./github/clients.js";

export function buildApp(
  db: Db,
  opts: {
    keyring: Keyring;
    logger?: boolean;
    queue?: DeploymentQueue;
    domainQueue?: DomainQueue;
    baseDomain?: string;
    githubWebhookSecret?: string;
    githubInstallationTokenClient?: GitHubInstallationTokenClient;
    githubChecksClient?: GitHubChecksClient;
  },
) {
  const app = Fastify({ logger: opts.logger ?? false });
  registerOpenApi(app, { version: "0.1.0" });
  app.register(docsRoutes);

  app.get("/health", async () => ({ status: "ok" }));

  // Tudo em /v1 exige token; o hook fica restrito a este escopo encapsulado.
  app.register(
    async (v1) => {
      v1.addHook("onRequest", authenticate(db));
      await v1.register(organizationRoutes, { db });
      await v1.register(projectRoutes, { db });
      await v1.register(environmentRoutes, { db });
      await v1.register(serviceRoutes, { db });
      await v1.register(connectionRoutes, { db });
      await v1.register(variableRoutes, { db, keyring: opts.keyring });
      await v1.register(domainRoutes, { db, baseDomain: opts.baseDomain, queue: opts.domainQueue });
      await v1.register(deploymentRoutes, { db, keyring: opts.keyring, queue: opts.queue });
    },
    { prefix: "/v1" },
  );

  // Registado fora do escopo acima de propósito: o webhook do GitHub se autentica por HMAC
  // (X-Hub-Signature-256), não por Bearer token, então não pode herdar o hook `authenticate`
  // dos outros endpoints de /v1. Ficando numa instância encapsulada própria (mesmo prefixo
  // "/v1"), o Fastify não propaga o onRequest de v1 para esta — a URL final é a mesma que a
  // arquitetura (§10) e o resto do código espera: POST /v1/github/webhooks.
  app.register(githubRoutes, {
    db,
    keyring: opts.keyring,
    queue: opts.queue,
    webhookSecret: opts.githubWebhookSecret,
    installationTokenClient: opts.githubInstallationTokenClient,
    checksClient: opts.githubChecksClient,
    prefix: "/v1",
  });

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
