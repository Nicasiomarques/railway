import {
  type AnyPgColumn,
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
// "ci": ephemeral environment created directly for a CI job (roadmap.md Phase 5), as opposed to
// "preview", which is only ever created by the GitHub PR webhook flow (api/src/routes/github.ts).
export const environmentType = pgEnum("environment_type", ["production", "staging", "preview", "custom", "ci"]);
export const serviceSource = pgEnum("service_source", [
  "github_repo",
  "image",
  "template",
  "postgres_template",
  "redis_template",
  "minio_template",
]);
export const deploymentStatus = pgEnum("deployment_status", DEPLOYMENT_STATUSES);
// "cron": created by the cron scheduler (workers/src/cron) when a cron service's schedule fires.
export const deploymentTrigger = pgEnum("deployment_trigger", ["push", "manual", "rollback", "redeploy", "cron"]);
export const domainType = pgEnum("domain_type", ["auto", "custom"]);
export const variableScope = pgEnum("variable_scope", ["project", "environment", "service_instance"]);
export const environmentProvisioningStatus = pgEnum("environment_provisioning_status", [
  "pending",
  "provisioning",
  "ready",
  "failed",
]);
export const subscriptionStatus = pgEnum("subscription_status", ["active", "canceled"]);
// "draft": created and line items populated by the billing worker; "finalized": closed, amounts
// immutable from this point (architecture.md's usage_events are append-only, so a finalized invoice
// is what makes a historical period's cost stable even as new usage_events keep arriving for the
// current period).
export const invoiceStatus = pgEnum("invoice_status", ["draft", "finalized"]);

// Identity comes from an external provider; we only store the link.
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    externalId: text("external_id").notNull(),
    email: text("email").notNull(),
    // Null for a user who has never set a password (e.g. created by an older flow, or a future
    // external-provider user). `POST /v1/auth/login` rejects login when this is null instead of
    // treating a missing password as valid — see api/src/auth/local.ts.
    passwordHash: text("password_hash"),
    ...timestamps,
  },
  (t) => [uniqueIndex("users_external_id_idx").on(t.externalId), uniqueIndex("users_email_idx").on(t.email)],
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

// Multi-region (roadmap.md Phase 4). Seeded by migration 0012 with one row carrying this fixed id,
// so every project created before regions existed backfills to it (projects.regionId's default)
// and single-cluster deployments need no region management at all -- see
// workers/src/runtime/registry.ts for how a regionId becomes a RuntimeAdapter.
export const DEFAULT_REGION_ID = "00000000-0000-0000-0000-000000000001";

export const regions = pgTable(
  "regions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    // The kubeconfig context this region's cluster runs on. Null means "whatever the kubeconfig's
    // own current-context is" -- the single-cluster behavior from before this table existed.
    kubeContext: text("kube_context"),
    ...timestamps,
  },
  (t) => [uniqueIndex("regions_slug_idx").on(t.slug)],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    regionId: uuid("region_id")
      .notNull()
      .default(DEFAULT_REGION_ID)
      .references(() => regions.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    // Node positions for the service canvas, keyed by serviceId: { [serviceId]: { x, y } }.
    // Written by the frontend (ServiceCanvas.tsx) via PATCH /projects/:projectId/canvas-layout.
    canvasLayout: jsonb("canvas_layout").$type<Record<string, { x: number; y: number }>>().notNull().default({}),
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
    parentEnvironmentId: uuid("parent_environment_id").references((): AnyPgColumn => environments.id),
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
    // Plain text, not a pgEnum: the allowed set ("web" | "worker" | "postgres" | "redis" | "cron")
    // is validated at the API layer (api/src/routes/services.ts), not enforced by the column.
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
    // Autoscaling (roadmap.md Phase 4). When false, `replicas` above is the instance's fixed count,
    // same as today; the four columns below are only meaningful (and only ever non-null) when true
    // -- see workers/src/runtime/adapter.ts's AutoscalingPolicy, which they're assembled into.
    autoscalingEnabled: boolean("autoscaling_enabled").notNull().default(false),
    minReplicas: integer("min_replicas"),
    maxReplicas: integer("max_replicas"),
    targetCpuPercent: integer("target_cpu_percent"),
    // A CPU request, in millicores, is what makes targetCpuPercent (a percentage of it) meaningful
    // to the Horizontal Pod Autoscaler -- see k8s.ts's deploymentObject.
    cpuRequestMillicores: integer("cpu_request_millicores"),
    healthCheck: jsonb("health_check"),
    overrides: jsonb("overrides"),
    // Cron expression (e.g. "0 3 * * *"). Only relevant when the owning service's kind is "cron";
    // null otherwise. See workers/src/cron/scheduler.ts.
    schedule: text("schedule"),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    uniqueIndex("service_instances_svc_env_idx").on(t.serviceId, t.environmentId),
    index("service_instances_environment_idx").on(t.environmentId),
  ],
);

// Immutable snapshot of variables resolved at deploy time.
export const envSnapshots = pgTable(
  "env_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serviceInstanceId: uuid("service_instance_id")
      .notNull()
      .references(() => serviceInstances.id),
    // Secret values are encrypted (envelope); never in plain text.
    payloadEnc: text("payload_enc").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("env_snapshots_instance_idx").on(t.serviceInstanceId)],
);

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
    rollbackOfId: uuid("rollback_of_id").references((): AnyPgColumn => deployments.id),
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
    index("variables_project_idx").on(t.projectId),
    index("variables_environment_idx").on(t.environmentId),
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
  (t) => [uniqueIndex("domains_hostname_idx").on(t.hostname), index("domains_instance_idx").on(t.serviceInstanceId)],
);

// Volumes attach to a service instance (architecture.md §6: stateful workloads get a PVC + a
// scheduled backup to object storage). backupState mirrors the backup worker's state machine
// ("none" until the first run; "pending" while a backup is in flight; "completed"/"failed" after).
export const volumes = pgTable(
  "volumes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serviceInstanceId: uuid("service_instance_id")
      .notNull()
      .references(() => serviceInstances.id),
    mountPath: text("mount_path").notNull(),
    sizeGb: integer("size_gb").notNull(),
    backupState: text("backup_state").notNull().default("none"),
    lastBackupAt: timestamp("last_backup_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("volumes_instance_idx").on(t.serviceInstanceId)],
);

// Outbound webhook subscriptions (roadmap.md Phase 5: "Webhooks and extensions"). The inverse of
// github_webhook_deliveries/githubRoutes' HMAC check: here WE sign the payload with `secret` the
// same way, for a third party to verify. `projectId` null means "every project in the organization".
export const webhookSubscriptions = pgTable(
  "webhook_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    projectId: uuid("project_id").references(() => projects.id),
    // Set only through routes/extensions.ts (roadmap.md Phase 5 "extensions"): an extension is a
    // webhook subscription with a manifest (name + description) attached, delivered through the
    // exact same worker (workers/src/webhooks) as a plain subscription - null on one of those.
    name: text("name"),
    description: text("description"),
    url: text("url").notNull(),
    // HMAC-SHA256 signing secret for outbound deliveries (workers/src/webhooks/adapter.ts),
    // envelope-encrypted the same way variables.valueEnc is (api/src/crypto/envelope.ts) --
    // the column holds ciphertext, never plaintext, as of this migration. Never returned by
    // the API once set (api/src/routes/webhooks.ts).
    secret: text("secret").notNull(),
    // Event types this subscription wants, e.g. ["deployment.status_changed"]. Not an enum: new
    // event types are expected to be added later without a migration.
    events: text("events").array().notNull().default([]),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    index("webhook_subscriptions_org_idx").on(t.organizationId),
    index("webhook_subscriptions_project_idx").on(t.projectId),
  ],
);

// Delivery attempts log (one row per attempt), in the spirit of audit_logs: lets an operator see
// why a subscriber's endpoint isn't receiving events.
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => webhookSubscriptions.id),
    event: text("event").notNull(),
    payload: jsonb("payload").notNull(),
    responseStatus: integer("response_status"),
    attempt: integer("attempt").notNull().default(1),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("webhook_deliveries_subscription_idx").on(t.subscriptionId)],
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
  (t) => [
    primaryKey({ columns: [t.fromInstanceId, t.toInstanceId] }),
    index("connections_to_instance_idx").on(t.toInstanceId),
  ],
);

export const githubRepoLinks = pgTable(
  "github_repo_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    installationId: bigint("installation_id", { mode: "bigint" }).notNull(),
    repoId: bigint("repo_id", { mode: "bigint" }).notNull(),
    branchRules: jsonb("branch_rules"),
    ...timestamps,
  },
  // A repo (within an installation) links to a single project; the push webhook resolves through here.
  (t) => [uniqueIndex("github_repo_links_installation_repo_idx").on(t.installationId, t.repoId)],
);

// Idempotency for GitHub webhooks by X-GitHub-Delivery. Doesn't fit `idempotency_keys`
// because there's no authenticated user behind the call (it's GitHub calling the platform).
export const githubWebhookDeliveries = pgTable("github_webhook_deliveries", {
  deliveryId: text("delivery_id").primaryKey(),
  event: text("event").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
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

// Billing (roadmap.md Phase 4: "Billing on top of usage_events"). Pricing tiers are reference data,
// not user input: seeded by the migration that creates this table (api/drizzle), updated only by a
// future migration, never through the API. pricePerReplicaMinuteCents and includedReplicaMinutes
// are both scoped to the "replica_minutes" metric, the only one the usage worker writes today
// (workers/src/usage/worker.ts); a plan covering another metric would need its own column, not a
// generic schema, since the billing worker has to know how to combine them.
export const plans = pgTable(
  "plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    pricePerReplicaMinuteCents: integer("price_per_replica_minute_cents").notNull(),
    includedReplicaMinutes: integer("included_replica_minutes").notNull().default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex("plans_slug_idx").on(t.slug)],
);

// One row per organization: an org with no row here has never picked a plan and isn't billed
// (the billing worker skips it, same as an instance with no workload is skipped by the usage
// worker). Unlike memberships (composite PK, many rows per org), a subscription is 1:1 with its
// organization, so the organization_id itself is the primary key.
export const organizationSubscriptions = pgTable("organization_subscriptions", {
  organizationId: uuid("organization_id")
    .primaryKey()
    .references(() => organizations.id),
  planId: uuid("plan_id")
    .notNull()
    .references(() => plans.id),
  status: subscriptionStatus("status").notNull().default("active"),
  ...timestamps,
});

// One invoice per organization per billed period. periodStart/periodEnd are the half-open range
// [start, end) the billing worker summed usage_events over -- same convention as the usage API's
// from/to (api/src/routes/usage.ts).
export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    status: invoiceStatus("status").notNull().default("draft"),
    totalCents: integer("total_cents").notNull().default(0),
    currency: text("currency").notNull().default("usd"),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    // The billing worker re-running for a period it already closed must update that invoice, not
    // duplicate it (mirrors reconcileJobId/runBackupJobId: one unit of work, one stable identity).
    uniqueIndex("invoices_org_period_idx").on(t.organizationId, t.periodStart, t.periodEnd),
    index("invoices_org_idx").on(t.organizationId),
  ],
);

// One line item per project per invoice (mirrors the per-project grouping in the usage API), so a
// customer can see which project drove the charge. Append-only alongside its invoice: regenerating
// an invoice (see the worker) replaces all of its line items in one transaction.
export const invoiceLineItems = pgTable(
  "invoice_line_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id),
    projectId: uuid("project_id").references(() => projects.id),
    description: text("description").notNull(),
    replicaMinutes: integer("replica_minutes").notNull(),
    amountCents: integer("amount_cents").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("invoice_line_items_invoice_idx").on(t.invoiceId)],
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
  (t) => [
    uniqueIndex("api_tokens_hash_idx").on(t.tokenHash),
    index("api_tokens_organization_idx").on(t.organizationId),
    index("api_tokens_user_idx").on(t.userId),
  ],
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
