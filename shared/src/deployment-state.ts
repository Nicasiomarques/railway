import { DEPLOYMENT_STATUSES, type DeploymentStatus } from "./statuses.js";

// Valid transitions of the deployment state machine (architecture.md §5.1).
// `Cancelled` and `Failed` are valid from any in-progress state; terminal states
// have no outgoing transitions. `Running` doesn't cancel: stopping an active deployment is a separate operation.
const TRANSITIONS: Record<DeploymentStatus, readonly DeploymentStatus[]> = {
  Queued: ["Building", "Failed", "Cancelled"],
  Building: ["Deploying", "Failed", "Cancelled"],
  Deploying: ["HealthChecking", "Failed", "Cancelled"],
  HealthChecking: ["Running", "Failed", "Cancelled"],
  Running: ["Superseded", "RolledBack"],
  Superseded: [],
  RolledBack: [],
  Failed: [],
  Cancelled: [],
};

export const TERMINAL_DEPLOYMENT_STATUSES: readonly DeploymentStatus[] = DEPLOYMENT_STATUSES.filter(
  (status) => TRANSITIONS[status].length === 0,
);

export function isTerminalDeploymentStatus(status: DeploymentStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export function canTransition(from: DeploymentStatus, to: DeploymentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidDeploymentTransitionError extends Error {
  constructor(
    public readonly from: DeploymentStatus,
    public readonly to: DeploymentStatus,
  ) {
    super(`Invalid deployment transition: ${from} → ${to}`);
    this.name = "InvalidDeploymentTransitionError";
  }
}

// Returns `to` when the transition is valid; throws otherwise.
export function transition(from: DeploymentStatus, to: DeploymentStatus): DeploymentStatus {
  if (!canTransition(from, to)) throw new InvalidDeploymentTransitionError(from, to);
  return to;
}
