import { describe, expect, it } from "vitest";
import { DEPLOYMENT_STATUSES } from "./statuses.js";
import {
  InvalidDeploymentTransitionError,
  TERMINAL_DEPLOYMENT_STATUSES,
  canTransition,
  isTerminalDeploymentStatus,
  transition,
} from "./deployment-state.js";

describe("máquina de estados de deployment", () => {
  it("caminho feliz percorre Queued → Running", () => {
    const path = ["Queued", "Building", "Deploying", "HealthChecking", "Running"] as const;
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it("Running é substituído por Superseded ou RolledBack", () => {
    expect(canTransition("Running", "Superseded")).toBe(true);
    expect(canTransition("Running", "RolledBack")).toBe(true);
    expect(canTransition("Running", "Failed")).toBe(false);
    expect(canTransition("Running", "Cancelled")).toBe(false);
  });

  it("Failed e Cancelled valem a partir de qualquer etapa em andamento", () => {
    for (const from of ["Queued", "Building", "Deploying", "HealthChecking"] as const) {
      expect(canTransition(from, "Failed")).toBe(true);
      expect(canTransition(from, "Cancelled")).toBe(true);
    }
  });

  it("não pula etapas", () => {
    expect(canTransition("Queued", "Deploying")).toBe(false);
    expect(canTransition("Building", "Running")).toBe(false);
    expect(canTransition("Deploying", "Running")).toBe(false);
  });

  it("não volta etapas", () => {
    expect(canTransition("Deploying", "Building")).toBe(false);
    expect(canTransition("HealthChecking", "Deploying")).toBe(false);
  });

  it("estados terminais não têm saída", () => {
    for (const from of TERMINAL_DEPLOYMENT_STATUSES) {
      for (const to of DEPLOYMENT_STATUSES) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it("terminais são Superseded, RolledBack, Failed e Cancelled", () => {
    expect([...TERMINAL_DEPLOYMENT_STATUSES].sort()).toEqual(
      ["Cancelled", "Failed", "RolledBack", "Superseded"],
    );
    expect(isTerminalDeploymentStatus("Running")).toBe(false);
    expect(isTerminalDeploymentStatus("Failed")).toBe(true);
  });

  it("transition devolve o novo estado ou lança erro tipado", () => {
    expect(transition("Queued", "Building")).toBe("Building");
    expect(() => transition("Queued", "Running")).toThrow(InvalidDeploymentTransitionError);
    try {
      transition("Failed", "Building");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidDeploymentTransitionError);
      expect((err as InvalidDeploymentTransitionError).from).toBe("Failed");
      expect((err as InvalidDeploymentTransitionError).to).toBe("Building");
    }
  });
});
