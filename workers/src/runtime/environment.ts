import type * as k8s from "@kubernetes/client-node";
import { CONTAINER_PORT } from "./adapter.js";

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
  // Decommissioning counterpart to ensureNamespace: deletes the whole namespace, cascading every
  // workload, Secret, NetworkPolicy and quota provisioned for it in one call. Idempotent: deleting
  // an already-gone namespace is not an error (see implementations).
  deleteNamespace(namespace: string): Promise<void>;
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

// Denies all ingress and egress for the namespace. Combined with workloadIngressPolicy and
// workloadEgressDnsPolicy below (NetworkPolicies are additive: a packet is let through if any
// policy selecting the pod allows it), not a blanket deny -- those two carve out exactly what a
// workload needs to be reachable and to resolve names. General internet egress (outbound calls
// from the workload itself) is a separate, still-open decision -- not added here.
export function defaultDenyPolicy(namespace: string): k8s.V1NetworkPolicy {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "default-deny", namespace },
    spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"] },
  };
}

// Lets traffic reach any workload in the namespace on the port it listens on: from another pod in
// the same namespace (Connections between service instances) and from `kubectl port-forward` or a
// NodePort/LoadBalancer Service (no ingress controller required) -- enough to validate a deployment
// is actually reachable with no public DNS/TLS/internet involved. Not scoped to a source, by design:
// there is no edge/ingress controller in this cluster yet to scope it to (that's the domain/edge
// feature, still to come) -- scoping ingress to it is a Fase B follow-up once it exists.
export function workloadIngressPolicy(namespace: string): k8s.V1NetworkPolicy {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "workload-ingress", namespace },
    spec: {
      podSelector: {},
      policyTypes: ["Ingress"],
      ingress: [{ ports: [{ port: CONTAINER_PORT, protocol: "TCP" }] }],
    },
  };
}

// Shared with the build pipeline's own egress policy (build/k8s-builder.ts's applyEgressPolicy):
// both need the same "let DNS through to CoreDNS in kube-system" rule, so it's defined once here.
export function kubeSystemDnsEgressRule(): k8s.V1NetworkPolicyEgressRule {
  return {
    to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } } }],
    ports: [
      { port: 53, protocol: "UDP" },
      { port: 53, protocol: "TCP" },
    ],
  };
}

// Without this, default-deny blocks egress entirely, so a workload can't even resolve a Service's
// DNS name (needed for Connections to reach each other by hostname, same as everything else that
// isn't a raw IP). Scoped to DNS only, in kube-system -- general outbound internet egress is not
// opened here.
export function workloadEgressDnsPolicy(namespace: string): k8s.V1NetworkPolicy {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "workload-egress-dns", namespace },
    spec: { podSelector: {}, policyTypes: ["Egress"], egress: [kubeSystemDnsEgressRule()] },
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
