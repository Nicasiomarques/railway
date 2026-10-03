// Mirrors only the fields the CLI consumes from the contracts in api/src/openapi/schemas.ts.

export type Organization = {
  id: string;
  name: string;
  slug: string;
  role: "owner" | "admin" | "member" | "viewer";
  createdAt: string;
};

export type Project = {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
};

export type Environment = {
  id: string;
  projectId: string;
  name: string;
  type: "production" | "staging" | "preview" | "custom";
};

export type ServiceInstanceSummary = {
  id: string;
  environmentId: string;
  environmentName: string | null;
  replicas: number;
};

export type Service = {
  id: string;
  projectId: string;
  name: string;
  kind: "web" | "worker" | "postgres" | "redis";
  source: "github_repo" | "image" | "template";
  instances: ServiceInstanceSummary[];
};

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

export type Deployment = {
  id: string;
  serviceInstanceId: string;
  versionNo: number;
  status: DeploymentStatus;
  trigger: "push" | "manual" | "rollback" | "redeploy";
  imageDigest: string | null;
  commitSha: string | null;
  createdAt: string;
  updatedAt: string;
};

export type VariableListItem = {
  key: string;
  isSecret: boolean;
  version: number;
  updatedAt: string;
  value: string | null;
};

export type Page<T> = { data: T[]; nextCursor: string | null };
export type ListOf<T> = { data: T[] };
