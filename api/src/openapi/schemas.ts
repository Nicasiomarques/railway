import { z } from "zod";

// Response contracts. Mirror what the routes return (see db/schema.ts).
// Dates are emitted as ISO 8601 in JSON.

const uuid = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const json = z.unknown();

export const LoginResponseSchema = z.object({
  token: z.string(),
  userId: uuid,
});

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
  // Multi-region (roadmap.md Phase 4). Defaults to the single default region when omitted at
  // creation -- see db/src/schema.ts's DEFAULT_REGION_ID.
  regionId: uuid,
  name: z.string(),
  slug: z.string(),
  canvasLayout: z.record(z.string(), z.object({ x: z.number(), y: z.number() })),
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: timestamp.nullable(),
});

export const RegionSchema = z.object({
  id: uuid,
  slug: z.string(),
  name: z.string(),
});

export const CanvasLayoutSchema = z.object({
  layout: z.record(z.string(), z.object({ x: z.number(), y: z.number() })),
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
  kind: z.enum(["web", "worker", "postgres", "redis", "cron", "object_storage"]),
  source: z.enum(["github_repo", "image", "template", "postgres_template", "redis_template", "minio_template"]),
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
  // Cron expression (e.g. "0 3 * * *"); only set when the owning service's kind is "cron".
  schedule: z.string().nullable(),
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
  schedule: z.string().nullable(),
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

export const VolumeSchema = z.object({
  id: uuid,
  serviceInstanceId: uuid,
  mountPath: z.string(),
  sizeGb: z.number().int(),
  backupState: z.enum(["none", "pending", "completed", "failed"]),
  lastBackupAt: timestamp.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

// The secret is never included: once set, it's write-only (api/src/routes/webhooks.ts).
export const WebhookSubscriptionSchema = z.object({
  id: uuid,
  organizationId: uuid,
  projectId: uuid.nullable(),
  url: z.string(),
  events: z.array(z.string()),
  isActive: z.boolean(),
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

// Usage aggregated from usage_events (architecture.md §3, §4), by project and, when the sample
// carried one, by service instance. serviceInstanceId/serviceName are null for a project-level
// row (a usage_events row with no serviceInstanceId). totalReplicaMinutes sums the "replica_minutes"
// metric only — the one metric the usage worker writes today.
export const UsageSummaryItemSchema = z.object({
  projectId: uuid,
  projectName: z.string(),
  serviceInstanceId: uuid.nullable(),
  serviceName: z.string().nullable(),
  totalReplicaMinutes: z.number(),
  sampleCount: z.number().int(),
});

// Reference pricing data, seeded by migration (db/src/schema.ts: `plans`) -- never created through
// the API, so there's no corresponding CreatePlanBody.
export const PlanSchema = z.object({
  id: uuid,
  slug: z.string(),
  name: z.string(),
  pricePerReplicaMinuteCents: z.number().int(),
  includedReplicaMinutes: z.number().int(),
});

// An organization with no subscription has never picked a plan and isn't billed (api/src/routes/billing.ts).
export const SubscriptionSchema = z.object({
  organizationId: uuid,
  plan: PlanSchema,
  status: z.enum(["active", "canceled"]),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const InvoiceLineItemSchema = z.object({
  id: uuid,
  projectId: uuid.nullable(),
  projectName: z.string().nullable(),
  description: z.string(),
  replicaMinutes: z.number().int(),
  amountCents: z.number().int(),
});

export const InvoiceSchema = z.object({
  id: uuid,
  organizationId: uuid,
  periodStart: timestamp,
  periodEnd: timestamp,
  status: z.enum(["draft", "finalized"]),
  totalCents: z.number().int(),
  currency: z.string(),
  finalizedAt: timestamp.nullable(),
  createdAt: timestamp,
});

export const InvoiceDetailSchema = InvoiceSchema.extend({
  lineItems: z.array(InvoiceLineItemSchema),
});

// Autoscaling (roadmap.md Phase 4). min/maxReplicas, targetCpuPercent and cpuRequestMillicores are
// only non-null when enabled is true -- see service_instances in db/src/schema.ts.
export const AutoscalingPolicySchema = z.object({
  instanceId: uuid,
  enabled: z.boolean(),
  // The instance's fixed replica count; what's used directly when enabled is false.
  replicas: z.number().int(),
  minReplicas: z.number().int().nullable(),
  maxReplicas: z.number().int().nullable(),
  targetCpuPercent: z.number().int().nullable(),
  cpuRequestMillicores: z.number().int().nullable(),
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
