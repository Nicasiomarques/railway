import yaml from "js-yaml";
import { ApiError } from "../errors.js";

export type ImportedService = {
  name: string;
  kind: "web" | "worker" | "cron";
  repoUrl?: string;
  schedule?: string;
  // Only variables with a literal value in the source manifest: Heroku's app.json and Render's
  // render.yaml both allow declaring a variable without a value (`"required": true`, `sync: false`)
  // when the value has to come from whoever deploys it - those are skipped rather than imported
  // as empty strings.
  variables: Record<string, string>;
};

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Mirrors the name rule in routes/services.ts's createServiceBody: lowercase, hyphenated. A
// manifest's process type or service name (e.g. Heroku's "web", a Render service called "API")
// doesn't necessarily already satisfy it.
function sanitizeName(raw: string): string {
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return NAME_RE.test(name) && name.length > 0 ? name : "service";
}

function parseJson(raw: string, provider: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ApiError(400, "invalid_manifest", `Could not parse ${provider} manifest as JSON: ${(err as Error).message}`);
  }
}

// Heroku app.json (https://devcenter.heroku.com/articles/app-json-schema): one service per
// `formation` process type with a non-zero quantity, defaulting to a single "web" process when
// `formation` is absent (the common case for a manifest written just to declare env vars).
// `env` values are only imported when they carry a literal `value` (not `required`-only).
export function parseHerokuManifest(raw: string): ImportedService[] {
  const doc = parseJson(raw, "Heroku") as {
    repository?: string;
    env?: Record<string, { value?: string }>;
    formation?: Record<string, { quantity?: number }>;
  };

  const variables: Record<string, string> = {};
  for (const [key, def] of Object.entries(doc.env ?? {})) {
    if (typeof def?.value === "string") variables[key] = def.value;
  }

  const formation = doc.formation && Object.keys(doc.formation).length > 0 ? doc.formation : { web: { quantity: 1 } };
  const services: ImportedService[] = [];
  for (const [processType, def] of Object.entries(formation)) {
    if ((def?.quantity ?? 1) <= 0) continue;
    services.push({
      name: sanitizeName(processType),
      kind: processType === "web" ? "web" : "worker",
      repoUrl: doc.repository,
      variables,
    });
  }
  if (services.length === 0) throw new ApiError(400, "invalid_manifest", "Heroku manifest declares no processes.");
  return services;
}

// Render's render.yaml (https://render.com/docs/blueprint-spec): a `services` list, each with a
// `type` (web/worker/cron), a `repo`, and optional `envVars` ({key, value} or {key, sync: false}
// for ones Render makes the deployer fill in by hand - those are skipped, same reasoning as above).
// A cron service's schedule comes from its own `schedule` field (a standard 5-field cron expression,
// same shape this platform's own `schedule` already expects).
export function parseRenderManifest(raw: string): ImportedService[] {
  let doc: unknown;
  try {
    doc = yaml.load(raw);
  } catch (err) {
    throw new ApiError(400, "invalid_manifest", `Could not parse Render manifest as YAML: ${(err as Error).message}`);
  }
  const root = doc as { services?: unknown[] } | null;
  if (!root || !Array.isArray(root.services) || root.services.length === 0) {
    throw new ApiError(400, "invalid_manifest", "Render manifest has no services.");
  }

  return root.services.map((raw) => {
    const svc = raw as {
      type?: string;
      name?: string;
      repo?: string;
      schedule?: string;
      envVars?: { key: string; value?: string; sync?: boolean }[];
    };
    if (!svc.name) throw new ApiError(400, "invalid_manifest", "A Render service is missing its name.");
    const kind: ImportedService["kind"] = svc.type === "cron" ? "cron" : svc.type === "worker" ? "worker" : "web";
    if (kind === "cron" && !svc.schedule) {
      throw new ApiError(400, "invalid_manifest", `Render service "${svc.name}" is a cron job but has no schedule.`);
    }
    const variables: Record<string, string> = {};
    for (const v of svc.envVars ?? []) {
      if (typeof v.value === "string") variables[v.key] = v.value;
    }
    return { name: sanitizeName(svc.name), kind, repoUrl: svc.repo, schedule: kind === "cron" ? svc.schedule : undefined, variables };
  });
}

// Generic JSON project export: `{ "services": [{ "name", "kind"?, "repoUrl"?, "schedule"?,
// "variables"? }] }`. Railway has no published, stable schema for a full-project export at the
// time this was written, so this accepts the same shape this platform's own API already uses
// for a service (routes/services.ts's createServiceBody) rather than guessing at Railway's
// internal one.
export function parseRailwayManifest(raw: string): ImportedService[] {
  const doc = parseJson(raw, "Railway") as { services?: unknown[] };
  if (!Array.isArray(doc.services) || doc.services.length === 0) {
    throw new ApiError(400, "invalid_manifest", "Railway manifest has no services.");
  }
  return doc.services.map((raw) => {
    const svc = raw as {
      name?: string;
      kind?: string;
      repoUrl?: string;
      schedule?: string;
      variables?: Record<string, string>;
    };
    if (!svc.name) throw new ApiError(400, "invalid_manifest", "A Railway service is missing its name.");
    const kind: ImportedService["kind"] = svc.kind === "cron" ? "cron" : svc.kind === "worker" ? "worker" : "web";
    return {
      name: sanitizeName(svc.name),
      kind,
      repoUrl: svc.repoUrl,
      schedule: kind === "cron" ? svc.schedule : undefined,
      variables: svc.variables ?? {},
    };
  });
}

export type ImportProvider = "heroku" | "render" | "railway";

export function parseImportManifest(provider: ImportProvider, raw: string): ImportedService[] {
  if (provider === "heroku") return parseHerokuManifest(raw);
  if (provider === "render") return parseRenderManifest(raw);
  return parseRailwayManifest(raw);
}
