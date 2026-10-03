import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { deployments, environments, organizations, projects, serviceInstances, services, type Db } from "@railway-like/db";

// Resets the deployment tables. Only use on a dedicated test database, or with no other suite running in parallel.
export async function resetDb(db: Db): Promise<void> {
  await db.execute(
    sql`truncate deployment_events, env_snapshots, deployments, service_instances, services, environments, projects, organizations restart identity cascade`,
  );
}

// Creates org → project → environment → service → instance; returns the instance id.
// Unique slugs per call: a test can create several instances.
export async function seedInstance(db: Db, replicas = 1): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [org] = await db.insert(organizations).values({ name: "Acme", slug: `acme-${suffix}` }).returning();
  const [project] = await db.insert(projects).values({ organizationId: org.id, name: "Web", slug: "web" }).returning();
  const [env] = await db.insert(environments).values({ projectId: project.id, name: "production", type: "production" }).returning();
  const [service] = await db.insert(services).values({ projectId: project.id, name: "app", kind: "web", source: "github_repo" }).returning();
  const [instance] = await db.insert(serviceInstances).values({ serviceId: service.id, environmentId: env.id, replicas }).returning();
  return instance.id;
}

export async function addDeployment(
  db: Db,
  instanceId: string,
  versionNo: number,
  status: "Deploying" | "Running" | "HealthChecking",
  imageDigest: string | null = "registry.local/app@sha256:aaa",
  envSnapshotId: string | null = null,
): Promise<string> {
  const [row] = await db
    .insert(deployments)
    .values({ serviceInstanceId: instanceId, versionNo, status, trigger: "manual", imageDigest, envSnapshotId })
    .returning();
  return row.id;
}

