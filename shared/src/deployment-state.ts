import { DEPLOYMENT_STATUSES, type DeploymentStatus } from "./statuses.js";

// Transições válidas da máquina de estados de deployment (architecture.md §5.1).
// `Cancelled` e `Failed` valem a partir de qualquer estado em andamento; estados
// terminais não têm saída. `Running` não cancela: parar um deployment ativo é outra operação.
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
    super(`Transição de deployment inválida: ${from} → ${to}`);
    this.name = "InvalidDeploymentTransitionError";
  }
}

// Retorna `to` quando a transição é válida; lança caso contrário.
export function transition(from: DeploymentStatus, to: DeploymentStatus): DeploymentStatus {
  if (!canTransition(from, to)) throw new InvalidDeploymentTransitionError(from, to);
  return to;
}
