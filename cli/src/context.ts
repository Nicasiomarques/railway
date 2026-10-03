import { findProjectConfig, type ProjectConfig } from "./config.js";
import { requireGlobalConfig, type ApiClientConfig } from "./http.js";

export type Context = ApiClientConfig & {
  project: ProjectConfig | null;
  projectDir: string | null;
};

// Resolves the URL/token from the global login and, if present, the project config
// (`.railway-like/config.json` in the current directory or an ancestor). The project
// config can override the API URL.
export function resolveContext(): Context {
  const global = requireGlobalConfig();
  const found = findProjectConfig();
  return {
    apiUrl: found?.config.apiUrl ?? global.apiUrl,
    token: global.token,
    project: found?.config ?? null,
    projectDir: found?.dir ?? null,
  };
}

export function resolveInstanceId(ctx: Context, override?: string): string {
  const instanceId = override ?? ctx.project?.serviceInstanceId;
  if (!instanceId) {
    throw new Error(
      "No service instance configured. Run `railway-like init` in the project directory, or use --instance <id>.",
    );
  }
  return instanceId;
}
