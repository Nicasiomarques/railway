import { and, eq, isNull } from "drizzle-orm";
import { ApiError } from "./errors.js";
import type { Db } from "./db/client.js";
import { memberships, projects, serviceInstances, services } from "./db/schema.js";

export type Role = "owner" | "admin" | "member" | "viewer";

// A missing membership becomes a 404 so we don't reveal that the resource exists.
export async function requireMembership(db: Db, userId: string, organizationId: string): Promise<Role> {
  const [m] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.organizationId, organizationId)))
    .limit(1);
  if (!m) throw new ApiError(404, "organization_not_found", "Organization not found.");
  return m.role;
}

export async function requireProjectAccess(
  db: Db,
  userId: string,
  projectId: string,
  opts: { write?: boolean } = {},
): Promise<{ organizationId: string; role: Role }> {
  const [row] = await db
    .select({ organizationId: projects.organizationId, role: memberships.role })
    .from(projects)
    .innerJoin(
      memberships,
      and(eq(memberships.organizationId, projects.organizationId), eq(memberships.userId, userId)),
    )
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
    .limit(1);
  if (!row) throw new ApiError(404, "project_not_found", "Project not found.");
  if (opts.write && row.role === "viewer") {
    throw new ApiError(403, "forbidden", "The 'viewer' role cannot modify this resource.");
  }
  return row;
}

export async function requireInstanceAccess(
  db: Db,
  userId: string,
  instanceId: string,
  opts: { write?: boolean } = {},
): Promise<{ organizationId: string; projectId: string; role: Role }> {
  const [row] = await db
    .select({
      organizationId: projects.organizationId,
      projectId: projects.id,
      role: memberships.role,
    })
    .from(serviceInstances)
    .innerJoin(services, eq(services.id, serviceInstances.serviceId))
    .innerJoin(projects, eq(projects.id, services.projectId))
    .innerJoin(
      memberships,
      and(eq(memberships.organizationId, projects.organizationId), eq(memberships.userId, userId)),
    )
    .where(and(eq(serviceInstances.id, instanceId), isNull(serviceInstances.deletedAt), isNull(services.deletedAt)))
    .limit(1);
  if (!row) throw new ApiError(404, "instance_not_found", "Instance not found.");
  if (opts.write && row.role === "viewer") {
    throw new ApiError(403, "forbidden", "The 'viewer' role cannot modify this resource.");
  }
  return row;
}
