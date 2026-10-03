import type * as k8s from "@kubernetes/client-node";

// Port for provisioning an environment's namespace (architecture.md §6). Separate from RuntimeAdapter:
// only the provisioning saga calls this interface. Each operation is an idempotent upsert.
// Implementations: InMemoryRuntime (tests) and K8sRuntime (k3s).

export interface EnvironmentQuota {
  requests: { cpu: string; memory: string };
  limits: { cpu: string; memory: string };
  pods: number;
}

export interface EnvironmentRuntime {
  ensureNamespace(namespace: string, labels: Record<string, string>): Promise<void>;
  applyDefaultDenyPolicy(namespace: string): Promise<void>;
  applyQuota(namespace: string, quota: EnvironmentQuota): Promise<void>;
}

// Quota for the whole environment. Fixed starting value; once per-project plans exist, it'll come from there.
export const DEFAULT_ENV_QUOTA: EnvironmentQuota = {
  requests: { cpu: "2", memory: "4Gi" },
  limits: { cpu: "4", memory: "8Gi" },
  pods: 20,
};

// Per-container default. Without it, with a CPU/memory ResourceQuota, pods with no requests/limits get rejected.
export const DEFAULT_CONTAINER_RESOURCES = {
  requests: { cpu: "100m", memory: "128Mi" },
  limits: { cpu: "500m", memory: "512Mi" },
};

export const PROVISIONER_FIELD_MANAGER = "railway-like-provisioner";

export function environmentLabels(projectId: string, environmentId: string): Record<string, string> {
  return {
    "pod-security.kubernetes.io/enforce": "restricted",
    "platform/project": projectId,
    "platform/env": environmentId,
  };
}

// Denies all ingress and egress for the namespace. Allowances (edge, inter-service traffic, internet) come later, via their own policy.
export function defaultDenyPolicy(namespace: string): k8s.V1NetworkPolicy {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "default-deny", namespace },
    spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"] },
  };
}

export function resourceQuotaObject(namespace: string, quota: EnvironmentQuota): k8s.V1ResourceQuota {
  return {
    apiVersion: "v1",
    kind: "ResourceQuota",
    metadata: { name: "env-quota", namespace },
    spec: {
      hard: {
        "requests.cpu": quota.requests.cpu,
        "requests.memory": quota.requests.memory,
        "limits.cpu": quota.limits.cpu,
        "limits.memory": quota.limits.memory,
        pods: String(quota.pods),
      },
    },
  };
}

// `default` goes on the wire under that name. The client type exposes `_default`, but the SSA patch doesn't
// convert that name: the cluster rejects `_default` with "field not declared in schema" (confirmed on k3d).
export function limitRangeObject(namespace: string) {
  return {
    apiVersion: "v1",
    kind: "LimitRange",
    metadata: { name: "env-defaults", namespace },
    spec: {
      limits: [
        {
          type: "Container",
          defaultRequest: DEFAULT_CONTAINER_RESOURCES.requests,
          default: DEFAULT_CONTAINER_RESOURCES.limits,
        },
      ],
    },
  };
}
