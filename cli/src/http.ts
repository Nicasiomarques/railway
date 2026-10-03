import { loadGlobalConfig } from "./config.js";

export type ApiClientConfig = { apiUrl: string; token: string };

type ProblemBody = {
  code?: string;
  detail?: string;
  errors?: { path: string; message: string }[];
};

// Espelha o formato RFC 9457 (problem+json) devolvido pela API (ver api/src/app.ts).
export class ApiProblem extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fieldErrors?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

export type RequestOptions = {
  json?: unknown;
  query?: Record<string, string | number | undefined>;
};

export async function apiRequest<T>(
  cfg: ApiClientConfig,
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const url = new URL(`/v1${path}`, cfg.apiUrl);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const headers = new Headers({ authorization: `Bearer ${cfg.token}` });
  let body: string | undefined;
  if (options.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.json);
  }

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body });
  } catch (err) {
    throw new ApiProblem(
      0,
      "network_error",
      `Não foi possível contactar a API em ${cfg.apiUrl}: ${(err as Error).message}`,
    );
  }

  if (!res.ok) throw await toApiProblem(res);
  if (res.status === 204) return undefined as T;

  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

async function toApiProblem(res: Response): Promise<ApiProblem> {
  let body: ProblemBody = {};
  try {
    body = (await res.json()) as ProblemBody;
  } catch {
    // Resposta sem corpo JSON (ex. proxy/gateway no meio do caminho).
  }
  return new ApiProblem(
    res.status,
    body.code ?? "http_error",
    body.detail ?? res.statusText ?? `Erro HTTP ${res.status}`,
    body.errors,
  );
}

export function requireGlobalConfig(): ApiClientConfig {
  const config = loadGlobalConfig();
  if (!config) {
    throw new ApiProblem(
      0,
      "not_authenticated",
      "Nenhum login encontrado. Rode `railway-like login` primeiro.",
    );
  }
  return config;
}

// Usado para erros de qualquer origem (ApiProblem, erro de validação local etc.), nunca o JSON bruto.
export function formatError(err: unknown): string {
  if (err instanceof ApiProblem) {
    const lines = [`${err.message} (${err.code})`];
    for (const fieldError of err.fieldErrors ?? []) {
      lines.push(`  - ${fieldError.path}: ${fieldError.message}`);
    }
    return lines.join("\n");
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
