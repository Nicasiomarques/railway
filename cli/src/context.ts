import { findProjectConfig, type ProjectConfig } from "./config.js";
import { requireGlobalConfig, type ApiClientConfig } from "./http.js";

export type Context = ApiClientConfig & {
  project: ProjectConfig | null;
  projectDir: string | null;
};

// Resolve a URL/token do login global e, se existir, o config do projeto (`.railway-like/config.json`
// no diretório atual ou em algum ancestral). O config do projeto pode sobrepor a URL da API.
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
      "Nenhuma instância de serviço configurada. Rode `railway-like init` no diretório do projeto ou use --instance <id>.",
    );
  }
  return instanceId;
}
