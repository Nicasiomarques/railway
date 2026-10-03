import { loadGlobalConfig } from "./config.js";

export type ApiClientConfig = { apiUrl: string; token: string };

type ProblemBody = {
  code?: string;
  detail?: string;
  errors?: { path: string; message: string }[];
};

// Mirrors the RFC 9457 (problem+json) format returned by the API (see api/src/app.ts).
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
      `Could not reach the API at ${cfg.apiUrl}: ${(err as Error).message}`,
    );
  }

  if (!res.ok) throw await toApiProblem(res);
  if (res.status === 204) return undefined as T;

  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// Consumes a `text/event-stream` response line by line, calling `onLine` for each `data: <line>`
// payload as it arrives (no buffering until the end — this is a live tail). Errors are reported
// the same way as `apiRequest` (including problem+json parsing when the response isn't SSE at all).
// `signal` lets the caller abort the connection (e.g. on SIGINT) without it surfacing as an error.
export async function streamLines(
  cfg: ApiClientConfig,
  path: string,
  onLine: (line: string) => void,
  options: RequestOptions & { signal?: AbortSignal } = {},
): Promise<void> {
  const url = new URL(`/v1${path}`, cfg.apiUrl);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const headers = new Headers({ authorization: `Bearer ${cfg.token}` });

  let res: Response;
  try {
    res = await fetch(url, { method: "GET", headers, signal: options.signal });
  } catch (err) {
    if (options.signal?.aborted) return;
    throw new ApiProblem(
      0,
      "network_error",
      `Could not reach the API at ${cfg.apiUrl}: ${(err as Error).message}`,
    );
  }

  if (!res.ok) throw await toApiProblem(res);
  if (!res.body) return;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const fieldLine of rawEvent.split("\n")) {
          if (fieldLine.startsWith("data: ")) onLine(fieldLine.slice(6));
          else if (fieldLine.startsWith("data:")) onLine(fieldLine.slice(5));
        }
      }
    }
  } catch (err) {
    if (!options.signal?.aborted) throw err;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function toApiProblem(res: Response): Promise<ApiProblem> {
  let body: ProblemBody = {};
  try {
    body = (await res.json()) as ProblemBody;
  } catch {
    // Response with no JSON body (e.g. a proxy/gateway in the middle).
  }
  return new ApiProblem(
    res.status,
    body.code ?? "http_error",
    body.detail ?? res.statusText ?? `HTTP error ${res.status}`,
    body.errors,
  );
}

export function requireGlobalConfig(): ApiClientConfig {
  const config = loadGlobalConfig();
  if (!config) {
    throw new ApiProblem(
      0,
      "not_authenticated",
      "No login found. Run `railway-like login` first.",
    );
  }
  return config;
}

// Used for errors from any source (ApiProblem, local validation error, etc.), never the raw JSON.
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
