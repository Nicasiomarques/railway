import type * as k8s from "@kubernetes/client-node";

// Porta de provisionamento do namespace de um ambiente (architecture.md §6). Separada de RuntimeAdapter:
// só a saga de provisionamento chama esta interface. Cada operação é upsert idempotente.
// Implementações: InMemoryRuntime (testes) e K8sRuntime (k3s).

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

// Quota do ambiente inteiro. Valor inicial fixo; quando houver plano por projeto, vem de lá.
export const DEFAULT_ENV_QUOTA: EnvironmentQuota = {
  requests: { cpu: "2", memory: "4Gi" },
  limits: { cpu: "4", memory: "8Gi" },
  pods: 20,
};

// Padrão por contêiner. Sem ele, com ResourceQuota de CPU/memória, pods sem requests/limits são rejeitados.
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

// Nega todo ingress e egress do namespace. Liberações (edge, tráfego entre serviços, internet) entram depois, por política própria.
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

// `default` vai no wire com esse nome. O tipo do cliente expõe `_default`, mas o patch SSA não converte esse nome:
// o cluster rejeita `_default` com "field not declared in schema" (confirmado no k3d).
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
