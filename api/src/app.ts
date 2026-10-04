import Fastify from "fastify";
import { ZodError } from "zod";
import { authenticate } from "./auth.js";
import type { AuthProvider } from "./auth/provider.js";
import { LocalAuthProvider } from "./auth/local.js";
import { ApiError } from "./errors.js";
import type { Db } from "./db/client.js";
import { authRoutes } from "./routes/auth.js";
import { organizationRoutes } from "./routes/organizations.js";
import { projectRoutes } from "./routes/projects.js";
import { environmentRoutes } from "./routes/environments.js";
import { serviceRoutes } from "./routes/services.js";
import { connectionRoutes } from "./routes/connections.js";
import { variableRoutes } from "./routes/variables.js";
import { domainRoutes } from "./routes/domains.js";
import { volumeRoutes } from "./routes/volumes.js";
import { usageRoutes } from "./routes/usage.js";
import type { Keyring } from "./crypto/envelope.js";
import { registerOpenApi } from "./openapi/index.js";
import { docsRoutes } from "./openapi/docs.js";
import { deploymentRoutes } from "./routes/deployments.js";
import { githubRoutes } from "./routes/github.js";
import type { BackupQueue, DeploymentQueue, DomainQueue } from "./queue.js";
import type { GitHubChecksClient, GitHubInstallationTokenClient } from "./github/clients.js";
import type { RuntimeReader } from "./runtime.js";

export function buildApp(
  db: Db,
  opts: {
    keyring: Keyring;
    logger?: boolean;
    queue?: DeploymentQueue;
    domainQueue?: DomainQueue;
    backupQueue?: BackupQueue;
    baseDomain?: string;
    githubWebhookSecret?: string;
    githubInstallationTokenClient?: GitHubInstallationTokenClient;
    githubChecksClient?: GitHubChecksClient;
    runtime?: RuntimeReader;
    authProvider?: AuthProvider;
  },
) {
  const app = Fastify({ logger: opts.logger ?? false });
  const authProvider = opts.authProvider ?? new LocalAuthProvider(db);
  registerOpenApi(app, { version: "0.1.0" });
  app.register(docsRoutes);

  app.get("/health", async () => ({ status: "ok" }));

  // Everything under /v1 requires a token; the hook is scoped to this encapsulated context.
  app.register(
    async (v1) => {
      v1.addHook("onRequest", authenticate(db));
      await v1.register(organizationRoutes, { db });
      await v1.register(usageRoutes, { db });
      await v1.register(projectRoutes, { db });
      await v1.register(environmentRoutes, { db });
      await v1.register(serviceRoutes, { db });
      await v1.register(connectionRoutes, { db });
      await v1.register(variableRoutes, { db, keyring: opts.keyring });
      await v1.register(domainRoutes, { db, baseDomain: opts.baseDomain, queue: opts.domainQueue });
      await v1.register(volumeRoutes, { db, backupQueue: opts.backupQueue });
      await v1.register(deploymentRoutes, { db, keyring: opts.keyring, queue: opts.queue, runtime: opts.runtime });
    },
    { prefix: "/v1" },
  );

  // Registered outside the authenticated scope above, same reasoning as the GitHub webhook below:
  // a client has no API token yet when it logs in, so this route can't sit behind the
  // `authenticate` hook that protects the rest of /v1. Same "/v1" prefix, own encapsulated
  // instance, so Fastify doesn't propagate v1's onRequest hook to it.
  app.register(authRoutes, { authProvider, prefix: "/v1" });

  // Registered outside the scope above on purpose: the GitHub webhook authenticates via HMAC
  // (X-Hub-Signature-256), not Bearer, so it can't inherit the `authenticate` hook from the
  // other /v1 endpoints. By being its own encapsulated instance (same "/v1" prefix), Fastify
  // doesn't propagate v1's onRequest to it — the final URL is the same one the architecture
  // (§10) and the rest of the code expect: POST /v1/github/webhooks.
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

// Errors in RFC 9457 (problem+json) format, with a stable `code` for the client.
function toProblem(err: unknown, instance: string) {
  if (err instanceof ApiError) {
    return { type: "about:blank", title: err.code, status: err.status, detail: err.message, code: err.code, instance };
  }
  if (err instanceof ZodError) {
    return {
      type: "about:blank",
      title: "validation_failed",
      status: 400,
      detail: "Invalid body or parameters.",
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
  return { type: "about:blank", title: "internal_error", status: 500, detail: "Internal error.", code: "internal_error", instance };
}
