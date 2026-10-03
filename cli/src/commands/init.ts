import { saveProjectConfig, type ProjectConfig } from "../config.js";
import { resolveContext } from "../context.js";
import { apiRequest } from "../http.js";
import { select } from "../prompt.js";
import type { Environment, ListOf, Organization, Page, Project, Service } from "../types.js";

async function fetchAllProjects(ctx: { apiUrl: string; token: string }, organizationId: string): Promise<Project[]> {
  const projects: Project[] = [];
  let cursor: string | undefined;
  do {
    const page = await apiRequest<Page<Project>>(ctx, "GET", "/projects", {
      query: { organizationId, limit: 100, cursor },
    });
    projects.push(...page.data);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return projects;
}

export async function initCommand(): Promise<void> {
  const ctx = resolveContext();

  const organizations = await apiRequest<ListOf<Organization>>(ctx, "GET", "/organizations");
  if (organizations.data.length === 0) {
    throw new Error("No organization found for this token. Create one through the API before running `init`.");
  }
  const organization = await select(
    "Organization",
    organizations.data.map((org) => ({ label: `${org.name} (${org.slug})`, value: org })),
  );

  const projects = await fetchAllProjects(ctx, organization.id);
  if (projects.length === 0) {
    throw new Error(`Organization "${organization.name}" has no projects yet.`);
  }
  const project = await select(
    "Project",
    projects.map((p) => ({ label: `${p.name} (${p.slug})`, value: p })),
  );

  const environments = await apiRequest<ListOf<Environment>>(ctx, "GET", `/projects/${project.id}/environments`);
  if (environments.data.length === 0) {
    throw new Error(`Project "${project.name}" has no environments.`);
  }
  const environment = await select(
    "Environment",
    environments.data.map((env) => ({ label: `${env.name} (${env.type})`, value: env })),
  );

  const services = await apiRequest<ListOf<Service>>(ctx, "GET", `/projects/${project.id}/services`);
  const optionsPerService = services.data
    .map((service) => ({ service, instance: service.instances.find((i) => i.environmentId === environment.id) }))
    .filter((entry): entry is { service: Service; instance: NonNullable<typeof entry.instance> } => entry.instance !== undefined);
  if (optionsPerService.length === 0) {
    throw new Error(`Project "${project.name}" has no services in environment "${environment.name}".`);
  }
  const chosen = await select(
    "Service (used by `deploy`, `status` and `env`)",
    optionsPerService.map(({ service, instance }) => ({ label: service.name, value: { service, instance } })),
  );

  const config: ProjectConfig = {
    organizationId: organization.id,
    organizationName: organization.name,
    projectId: project.id,
    projectName: project.name,
    environmentId: environment.id,
    environmentName: environment.name,
    serviceInstanceId: chosen.instance.id,
    serviceName: chosen.service.name,
  };

  const path = saveProjectConfig(process.cwd(), config);
  console.log(`Configuration saved to ${path}.`);
}
