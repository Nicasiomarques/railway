import { type SQL, and, eq, isNull, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { ApiError } from "./errors.js";
import type { Db } from "./db/client.js";
import { environments, projects, services } from "./db/schema.js";

// Same pattern as routes/deployments.ts and idempotency.ts: these checks are meant to run inside
// the caller's transaction (so the count and the insert that follows see a consistent snapshot),
// so they accept either a plain Db or a transaction handle.
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTx = Db | Tx;

// Phase 3 (docs/roadmap.md) / architecture.md §12 risk #12: simple, fixed creation quotas to
// slow down abuse. Not configurable per organization yet - plain constants is enough for now.
export const MAX_PROJECTS_PER_ORGANIZATION = 20;
export const MAX_SERVICES_PER_PROJECT = 50;
export const MAX_ENVIRONMENTS_PER_PROJECT = 10;

// Counts the non-soft-deleted rows of `table` matching `where`, as a plain number
// (pg returns count(*) as a string since it's a bigint).
async function countRows(db: DbOrTx, table: PgTable, where: SQL | undefined): Promise<number> {
  const [row] = await db
    .select({ value: sql<string>`count(*)` })
    .from(table)
    .where(where);
  return Number(row?.value ?? 0);
}

async function assertUnderQuota(
  db: DbOrTx,
  table: PgTable,
  fkColumn: PgColumn,
  fkValue: string,
  deletedAtColumn: PgColumn,
  limit: number,
  code: string,
  resourceLabel: string,
  parentLabel: string,
): Promise<void> {
  const current = await countRows(db, table, and(eq(fkColumn, fkValue), isNull(deletedAtColumn)));
  if (current >= limit) {
    throw new ApiError(
      403,
      code,
      `This ${parentLabel} already has ${current} ${resourceLabel}, which is the maximum allowed (${limit}).`,
    );
  }
}

// Throws 403 quota_exceeded when the organization is already at MAX_PROJECTS_PER_ORGANIZATION.
export function assertProjectQuota(db: DbOrTx, organizationId: string): Promise<void> {
  return assertUnderQuota(
    db,
    projects,
    projects.organizationId,
    organizationId,
    projects.deletedAt,
    MAX_PROJECTS_PER_ORGANIZATION,
    "quota_exceeded",
    "projects",
    "organization",
  );
}

// Throws 403 quota_exceeded when the project is already at MAX_SERVICES_PER_PROJECT.
export function assertServiceQuota(db: DbOrTx, projectId: string): Promise<void> {
  return assertUnderQuota(
    db,
    services,
    services.projectId,
    projectId,
    services.deletedAt,
    MAX_SERVICES_PER_PROJECT,
    "quota_exceeded",
    "services",
    "project",
  );
}

// Throws 403 quota_exceeded when the project is already at MAX_ENVIRONMENTS_PER_PROJECT.
// Not called from any route today (environments only have a creation path implicit in
// project creation plus the one seeded there - see routes/environments.ts, GET only), but kept
// here so the one place that creates environments can enforce it without duplicating the logic.
export function assertEnvironmentQuota(db: DbOrTx, projectId: string): Promise<void> {
  return assertUnderQuota(
    db,
    environments,
    environments.projectId,
    projectId,
    environments.deletedAt,
    MAX_ENVIRONMENTS_PER_PROJECT,
    "quota_exceeded",
    "environments",
    "project",
  );
}
