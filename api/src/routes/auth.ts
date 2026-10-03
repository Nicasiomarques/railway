import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { LoginResponseSchema } from "../openapi/schemas.js";
import { ApiError } from "../errors.js";
import type { AuthProvider } from "../auth/provider.js";

export const loginBody = z.object({
  email: z.string().trim().email(),
});

// Registered outside the authenticated `/v1` scope in app.ts, the same way routes/github.ts
// registers the webhook outside it: logging in is how a client gets a token in the first place,
// so this route can't itself require one via the `authenticate` hook.
export const authRoutes: FastifyPluginAsync<{ authProvider: AuthProvider }> = async (app, { authProvider }) => {
  app.post(
    "/auth/login",
    {
      config: {
        openapi: {
          operationId: "login",
          tags: ["Auth"],
          summary: "Logs in by email (creating the user on first login) and issues a new API token",
          bodySchema: loginBody,
          success: { status: 200, description: "Logged in", schema: LoginResponseSchema },
          errors: [401],
        },
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
