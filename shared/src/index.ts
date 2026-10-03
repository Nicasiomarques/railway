export const DEPLOYMENT_STATUSES = [
  "Queued",
  "Building",
  "Deploying",
  "HealthChecking",
  "Running",
  "Superseded",
  "RolledBack",
  "Failed",
  "Cancelled",
] as const;

export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];
