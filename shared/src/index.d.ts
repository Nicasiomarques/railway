export declare const DEPLOYMENT_STATUSES: readonly ["Queued", "Building", "Deploying", "HealthChecking", "Running", "Superseded", "RolledBack", "Failed", "Cancelled"];
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];
