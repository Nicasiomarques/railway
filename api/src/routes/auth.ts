import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { LoginResponseSchema } from "../openapi/schemas.js";
import { ApiError } from "../errors.js";
import type { AuthProvider } from "../auth/provider.js";

export const registerBody = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8),
});

export const loginBody = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

// Registered outside the authenticated `/v1` scope in app.ts, the same way routes/github.ts
// registers the webhook outside it: logging in/registering is how a client gets a token in the
// first place, so these routes can't themselves require one via the `authenticate` hook.
export const authRoutes: FastifyPluginAsync<{
  authProvider: AuthProvider;
  rateLimit?: { max?: number; windowMs?: number };
}> = async (app, { authProvider, rateLimit }) => {
  // Limited by IP, not by user: there's no userId yet, and both routes are prime targets for
  // brute-force / email enumeration / credential stuffing.
  const ipRateLimit = rateLimit
    ? { max: rateLimit.max, timeWindow: rateLimit.windowMs, keyGenerator: (request: { ip: string }) => request.ip }
    : undefined;

  app.post(
    "/auth/register",
    {
      config: {
        openapi: {
          operationId: "register",
          tags: ["Auth"],
          summary: "Creates a new account with an email and password, and issues a new API token",
          bodySchema: registerBody,
          success: { status: 201, description: "Registered", schema: LoginResponseSchema },
          errors: [409, 429],
        },
        rateLimit: ipRateLimit,
      },
    },
    async (request, reply) => {
      const body = registerBody.parse(request.body);
      const result = await authProvider.register(body);
      if (result === "email_taken") {
        throw new ApiError(409, "email_taken", "An account with this email already exists.");
      }
      reply.code(201);
      return { token: result.token, userId: result.userId };
    },
  );

  app.post(
    "/auth/login",
    {
      config: {
        openapi: {
          operationId: "login",
          tags: ["Auth"],
          summary: "Logs in with an email and password and issues a new API token",
          bodySchema: loginBody,
          success: { status: 200, description: "Logged in", schema: LoginResponseSchema },
          errors: [401, 429],
        },
        rateLimit: ipRateLimit,
      },
    },
    async (request) => {
      const body = loginBody.parse(request.body);
      const result = await authProvider.login(body);
      if (!result) throw new ApiError(401, "invalid_credentials", "Could not log in with these credentials.");
      return { token: result.token, userId: result.userId };
    },
  );
};
