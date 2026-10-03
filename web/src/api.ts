// Dev token stored in localStorage. Not suitable for production (use an httpOnly cookie).
const TOKEN_KEY = "railway_like.token";

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (token: string) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

export class ApiProblem extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type RequestOptions = Omit<RequestInit, "body"> & { json?: unknown };

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  const token = tokenStore.get();
  if (token) headers.set("authorization", `Bearer ${token}`);

  let body: BodyInit | undefined;
  if (options.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.json);
  }

  const res = await fetch(`/v1${path}`, { ...options, headers, body });
  if (!res.ok) {
    const problem = await res.json().catch(() => ({}));
    throw new ApiProblem(res.status, problem.code ?? "error", problem.detail ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export type Organization = { id: string; name: string; slug: string; role: string };
export type Project = { id: string; organizationId: string; name: string; slug: string };
export type Environment = { id: string; name: string; type: string };
export type Service = {
  id: string;
  name: string;
  kind: string;
  source: string;
  rootDir: string;
  instances: { id: string; environmentName: string | null; replicas: number }[];
};
export type Connection = { fromInstanceId: string; toInstanceId: string; environmentName: string };

export type DeploymentStatus =
  | "Queued"
  | "Building"
  | "Deploying"
  | "HealthChecking"
  | "Running"
  | "Superseded"
  | "RolledBack"
  | "Failed"
  | "Cancelled";

export const TERMINAL_STATUSES: DeploymentStatus[] = ["Running", "Superseded", "RolledBack", "Failed", "Cancelled"];

export type Deployment = {
  id: string;
  serviceInstanceId: string;
  versionNo: number;
  status: DeploymentStatus;
  trigger: string;
  imageDigest: string | null;
  commitSha: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DeploymentDetail = Deployment & {
  events: { fromStatus: DeploymentStatus | null; toStatus: DeploymentStatus; reason: string | null; occurredAt: string }[];
};

// List from GET /services/{instanceId}/variables: only the instance's own variables
// (the API doesn't yet resolve environment/project inheritance on this route). `value` comes back null when isSecret.
export type Variable = {
  key: string;
  isSecret: boolean;
  version: number;
  updatedAt: string;
  value: string | null;
};

// From GET /services/{instanceId}/metrics. Always a current snapshot (no time series in the MVP).
export type MetricsSnapshot = {
  instanceId: string;
  replicas: number;
  readyReplicas: number;
  image: string | null;
  status: "running" | "stopped";
};
