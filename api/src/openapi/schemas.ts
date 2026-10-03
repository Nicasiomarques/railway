import { z } from "zod";

// Response contracts. Mirror what the routes return (see db/schema.ts).
// Dates are emitted as ISO 8601 in JSON.

const uuid = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const json = z.unknown();

export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string(),
  code: z.string(),
  instance: z.string(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

export const OrganizationSchema = z.object({
  id: uuid,
  name: z.string(),
  slug: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: timestamp.nullable(),
});

export const OrganizationSummarySchema = z.object({
  id: uuid,
  name: z.string(),
  slug: z.string(),
  role: z.enum(["owner", "admin", "member", "viewer"]),
  createdAt: timestamp,
});

export const ProjectSchema = z.object({
  id: uuid,
  organizationId: uuid,
  name: z.string(),
  slug: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: timestamp.nullable(),
});

export const EnvironmentSchema = z.object({
  id: uuid,
  projectId: uuid,
  name: z.string(),
  type: z.enum(["production", "staging", "preview", "custom"]),
  parentEnvironmentId: uuid.nullable(),
  branchRule: z.string().nullable(),
  ttlAt: timestamp.nullable(),
  sleepPolicy: json.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: timestamp.nullable(),
});

export const ServiceSchema = z.object({
  id: uuid,
  projectId: uuid,
  name: z.string(),
  kind: z.enum(["web", "worker", "postgres", "redis"]),
  source: z.enum(["github_repo", "image", "template"]),
  rootDir: z.string(),
  repoUrl: z.string().nullable(),
  detectionSnapshot: json.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: timestamp.nullable(),
});

export const ServiceInstanceSchema = z.object({
  id: uuid,
  serviceId: uuid,
  environmentId: uuid,
  resources: json.nullable(),
  replicas: z.number().int(),
  healthCheck: json.nullable(),
  overrides: json.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: timestamp.nullable(),
});

// In the listing, each service carries a summary of its instances per environment.
export const ServiceInstanceSummarySchema = z.object({
  id: uuid,
  environmentId: uuid,
  environmentName: z.string().nullable(),
  replicas: z.number().int(),
});

export const ServiceWithInstancesSchema = ServiceSchema.extend({
  instances: z.array(ServiceInstanceSchema),
});

export const ServiceListItemSchema = ServiceSchema.extend({
  instances: z.array(ServiceInstanceSummarySchema),
});

export const ConnectionSchema = z.object({
  fromInstanceId: uuid,
  toInstanceId: uuid,
  environmentName: z.string(),
});

export const ConnectionListItemSchema = ConnectionSchema.extend({
  createdAt: timestamp,
});

// Secrets come back with value null; the client only knows they exist.
export const VariableListItemSchema = z.object({
  key: z.string(),
  isSecret: z.boolean(),
  version: z.number().int(),
  updatedAt: timestamp,
  value: z.string().nullable(),
});

export const ResolvedVariableSchema = z.object({
  key: z.string(),
  isSecret: z.boolean(),
  value: z.string().nullable(),
});

export const VariableUpsertSchema = z.object({
  key: z.string(),
  isSecret: z.boolean(),
  version: z.number().int(),
  updatedAt: timestamp,
});

export const DomainSchema = z.object({
  id: uuid,
  serviceInstanceId: uuid,
  hostname: z.string(),
  type: z.enum(["auto", "custom"]),
  tlsState: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const paginated = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ data: z.array(item), nextCursor: z.string().nullable() });

export const listOf = <T extends z.ZodTypeAny>(item: T) => z.object({ data: z.array(item) });

export const DeploymentSchema = z.object({
  id: uuid,
  serviceInstanceId: uuid,
  versionNo: z.number().int(),
  status: z.enum(["Queued", "Building", "Deploying", "HealthChecking", "Running", "Superseded", "RolledBack", "Failed", "Cancelled"]),
  trigger: z.enum(["push", "manual", "rollback", "redeploy"]),
  imageDigest: z.string().nullable(),
  commitSha: z.string().nullable(),
  rollbackOfId: uuid.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const DeploymentDetailSchema = DeploymentSchema.extend({
  events: z.array(
    z.object({
      fromStatus: DeploymentSchema.shape.status.nullable(),
      toStatus: DeploymentSchema.shape.status,
      reason: z.string().nullable(),
      occurredAt: timestamp,
    }),
  ),
});

export const BuildLogSchema = z.object({
  content: z.string(),
  updatedAt: timestamp.nullable(),
});

// `id` is a bigint identity column in the database; it's carried as a string here since JSON/JS
// numbers can't represent the full bigint range (and `JSON.stringify` can't serialize a BigInt at all).
export const AuditLogSchema = z.object({
  id: z.string(),
  actorId: uuid.nullable(),
  action: z.string(),
  target: z.string().nullable(),
  metadata: json.nullable(),
  createdAt: timestamp,
});

// Basic runtime snapshot of an instance (architecture.md §9, §10). No time series in the MVP:
// `from`/`to`/`metric` stay documented on the query so the contract already foresees that future.
export const MetricsSnapshotSchema = z.object({
  instanceId: uuid,
  replicas: z.number().int(),
  readyReplicas: z.number().int(),
  image: z.string().nullable(),
  status: z.enum(["running", "stopped"]),
});
