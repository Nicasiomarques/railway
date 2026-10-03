import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { DEPLOYMENT_STATUSES } from "@railway-like/shared";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

const softDelete = {
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
};

export const membershipRole = pgEnum("membership_role", ["owner", "admin", "member", "viewer"]);
export const environmentType = pgEnum("environment_type", ["production", "staging", "preview", "custom"]);
export const serviceSource = pgEnum("service_source", ["github_repo", "image", "template"]);
export const deploymentStatus = pgEnum("deployment_status", DEPLOYMENT_STATUSES);
export const deploymentTrigger = pgEnum("deployment_trigger", ["push", "manual", "rollback", "redeploy"]);
export const domainType = pgEnum("domain_type", ["auto", "custom"]);
export const variableScope = pgEnum("variable_scope", ["project", "environment", "service_instance"]);
export const environmentProvisioningStatus = pgEnum("environment_provisioning_status", [
  "pending",
  "provisioning",
  "ready",
  "failed",
]);

// Identity comes from an external provider; we only store the link.
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    externalId: text("external_id").notNull(),
    email: text("email").notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("users_external_id_idx").on(t.externalId)],
);

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    ...timestamps,
    ...softDelete,
  },
  (t) => [uniqueIndex("organizations_slug_idx").on(t.slug)],
);

export const memberships = pgTable(
  "memberships",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: membershipRole("role").notNull(),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.userId] })],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    ...timestamps,
    ...softDelete,
  },
  (t) => [uniqueIndex("projects_org_slug_idx").on(t.organizationId, t.slug)],
);

export const environments = pgTable(
  "environments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    name: text("name").notNull(),
    type: environmentType("type").notNull(),
    parentEnvironmentId: uuid("parent_environment_id"),
    branchRule: text("branch_rule"),
    ttlAt: timestamp("ttl_at", { withTimezone: true }),
    sleepPolicy: jsonb("sleep_policy"),
    // Provisioning saga (architecture.md §6): each completed step is recorded to resume from the point of failure.
    provisioningStatus: environmentProvisioningStatus("provisioning_status").notNull().default("pending"),
    provisioningSteps: jsonb("provisioning_steps").$type<string[]>().notNull().default([]),
    provisioningError: text("provisioning_error"),
    ...timestamps,
    ...softDelete,
  },
  (t) => [uniqueIndex("environments_project_name_idx").on(t.projectId, t.name)],
);

// Service is the definition; ServiceInstance is its presence in an environment.
export const services = pgTable(
  "services",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    source: serviceSource("source").notNull(),
    // Only for source github_repo: clone URL. Commits arrive via the deployment.
    repoUrl: text("repo_url"),
    rootDir: text("root_dir").notNull().default("/"),
    detectionSnapshot: jsonb("detection_snapshot"),
    ...timestamps,
    ...softDelete,
  },
  (t) => [uniqueIndex("services_project_name_idx").on(t.projectId, t.name)],
);

export const serviceInstances = pgTable(
  "service_instances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id),
    resources: jsonb("resources"),
    replicas: integer("replicas").notNull().default(1),
    healthCheck: jsonb("health_check"),
    overrides: jsonb("overrides"),
    ...timestamps,
    ...softDelete,
  },
  (t) => [uniqueIndex("service_instances_svc_env_idx").on(t.serviceId, t.environmentId)],
);

// Immutable snapshot of variables resolved at deploy time.
export const envSnapshots = pgTable("env_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  serviceInstanceId: uuid("service_instance_id")
    .notNull()
    .references(() => serviceInstances.id),
  // Secret values are encrypted (envelope); never in plain text.
  payloadEnc: text("payload_enc").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const deployments = pgTable(
  "deployments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serviceInstanceId: uuid("service_instance_id")
      .notNull()
      .references(() => serviceInstances.id),
    versionNo: integer("version_no").notNull(),
    commitSha: text("commit_sha"),
    branch: text("branch"),
    author: text("author"),
    status: deploymentStatus("status").notNull(),
    trigger: deploymentTrigger("triggered_by").notNull(),
    imageDigest: text("image_digest"),
    envSnapshotId: uuid("env_snapshot_id").references(() => envSnapshots.id),
    // Rollback points to the source deployment, without a rebuild.
    rollbackOfId: uuid("rollback_of_id"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("deployments_instance_version_idx").on(t.serviceInstanceId, t.versionNo),
    index("deployments_instance_status_idx").on(t.serviceInstanceId, t.status),
  ],
);

export const deploymentEvents = pgTable(
  "deployment_events",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id),
    fromStatus: deploymentStatus("from_status"),
    toStatus: deploymentStatus("to_status").notNull(),
    reason: text("reason"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("deployment_events_deployment_idx").on(t.deploymentId)],
);

export const builds = pgTable("builds", {
  id: uuid("id").primaryKey().defaultRandom(),
  deploymentId: uuid("deployment_id")
    .notNull()
    .references(() => deployments.id),
  logsRef: text("logs_ref"),
  cacheKey: text("cache_key"),
  durationMs: integer("duration_ms"),
  exitCode: integer("exit_code"),
  ...timestamps,
});

// Latest snapshot of the build logs (gate, clone and build). One row per deployment, overwritten on each read.
// builds.logsRef is reserved for external storage in the future; for now the content lives here.
export const buildLogs = pgTable("build_logs", {
  deploymentId: uuid("deployment_id")
    .primaryKey()
    .references(() => deployments.id),
  content: text("content").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const variables = pgTable(
  "variables",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: variableScope("scope").notNull(),
    projectId: uuid("project_id").references(() => projects.id),
    environmentId: uuid("environment_id").references(() => environments.id),
    serviceInstanceId: uuid("service_instance_id").references(() => serviceInstances.id),
    key: text("key").notNull(),
    valueEnc: text("value_enc").notNull(),
    isSecret: boolean("is_secret").notNull().default(false),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (t) => [
    index("variables_scope_key_idx").on(t.scope, t.key),
    // NULLs don't collide: rows from other scopes don't affect this uniqueness.
    uniqueIndex("variables_instance_key_idx").on(t.serviceInstanceId, t.key),
  ],
);

export const domains = pgTable(
  "domains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serviceInstanceId: uuid("service_instance_id")
      .notNull()
      .references(() => serviceInstances.id),
    hostname: text("hostname").notNull(),
    type: domainType("type").notNull(),
    tlsState: text("tls_state").notNull().default("pending"),
    ...timestamps,
  },
  (t) => [uniqueIndex("domains_hostname_idx").on(t.hostname)],
);

export const connections = pgTable(
  "connections",
  {
    fromInstanceId: uuid("from_instance_id")
      .notNull()
      .references(() => serviceInstances.id),
    toInstanceId: uuid("to_instance_id")
      .notNull()
      .references(() => serviceInstances.id),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.fromInstanceId, t.toInstanceId] })],
);

export const githubRepoLinks = pgTable("github_repo_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
  installationId: bigint("installation_id", { mode: "bigint" }).notNull(),
  repoId: bigint("repo_id", { mode: "bigint" }).notNull(),
  branchRules: jsonb("branch_rules"),
  ...timestamps,
});

// Append-only: no updatedAt and intentionally no soft delete.
export const usageEvents = pgTable(
  "usage_events",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    serviceInstanceId: uuid("service_instance_id").references(() => serviceInstances.id),
    metric: text("metric").notNull(),
    value: integer("value").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("usage_events_project_time_idx").on(t.projectId, t.occurredAt)],
);

// Append-only.
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    actorId: uuid("actor_id").references(() => users.id),
    action: text("action").notNull(),
    target: text("target"),
    metadata: jsonb("metadata"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("audit_logs_org_time_idx").on(t.organizationId, t.occurredAt)],
);

export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    scopes: text("scopes").array().notNull().default([]),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("api_tokens_hash_idx").on(t.tokenHash)],
);

// Responses for POSTs with an Idempotency-Key. Only recorded when the operation completes successfully.
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    responseStatus: integer("response_status").notNull(),
    responseBody: jsonb("response_body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("idempotency_user_key_idx").on(t.userId, t.key)],
);
