import * as k8s from "@kubernetes/client-node";
import { specHash, type RuntimeAdapter, type WorkloadRef, type WorkloadSpec, type WorkloadStatus } from "./adapter.js";
import {
  defaultDenyPolicy,
  limitRangeObject,
  PROVISIONER_FIELD_MANAGER,
  resourceQuotaObject,
  type EnvironmentQuota,
  type EnvironmentRuntime,
} from "./environment.js";

// Port the app listens on. Fixed at this stage: the service contract doesn't have a configurable port yet.
export const CONTAINER_PORT = 8080;

// All objects are applied with server-side apply under the same field manager: applying again is idempotent
// and fields removed from the spec leave the cluster.
const FIELD_MANAGER = "railway-like-reconciler";
const LABEL_WORKLOAD = "platform/workload";
const LABEL_SPEC_HASH = "platform/spec-hash";

export class K8sRuntime implements RuntimeAdapter, EnvironmentRuntime {
  private readonly core: k8s.CoreV1Api;
  private readonly apps: k8s.AppsV1Api;
  private readonly net: k8s.NetworkingV1Api;

  constructor(kubeconfig: k8s.KubeConfig) {
    this.core = kubeconfig.makeApiClient(k8s.CoreV1Api);
    this.apps = kubeconfig.makeApiClient(k8s.AppsV1Api);
    this.net = kubeconfig.makeApiClient(k8s.NetworkingV1Api);
  }

  // Sem contexto, usa o contexto atual do kubeconfig.
  static fromContext(context?: string): K8sRuntime {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    if (context) kc.setCurrentContext(context);
    return new K8sRuntime(kc);
  }

  async applyWorkload(spec: WorkloadSpec): Promise<void> {
    const ssa = k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.ServerSideApply);
    const apply = { fieldManager: FIELD_MANAGER, force: true };
    const hash = specHash(spec);
    const secretName = `${spec.name}-env`;

    await this.core.patchNamespace({ name: spec.namespace, body: namespaceObject(spec.namespace), ...apply }, ssa);
    await this.core.patchNamespacedSecret(
      { name: secretName, namespace: spec.namespace, body: secretObject(spec, secretName), ...apply },
      ssa,
    );
    await this.apps.patchNamespacedDeployment(
      { name: spec.name, namespace: spec.namespace, body: deploymentObject(spec, hash, secretName), ...apply },
      ssa,
    );
  }

  // Own field manager: the reconciler and the provisioner can write labels to the same namespace without erasing each other's.
  async ensureNamespace(namespace: string, labels: Record<string, string>): Promise<void> {
    const ssa = k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.ServerSideApply);
    const body = namespaceObject(namespace, labels);
    await this.core.patchNamespace({ name: namespace, body, fieldManager: PROVISIONER_FIELD_MANAGER, force: true }, ssa);
  }

  async applyDefaultDenyPolicy(namespace: string): Promise<void> {
    const ssa = k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.ServerSideApply);
    const body = defaultDenyPolicy(namespace);
    await this.net.patchNamespacedNetworkPolicy(
      { name: "default-deny", namespace, body, fieldManager: PROVISIONER_FIELD_MANAGER, force: true },
      ssa,
    );
  }

  async applyQuota(namespace: string, quota: EnvironmentQuota): Promise<void> {
    const ssa = k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.ServerSideApply);
    const apply = { fieldManager: PROVISIONER_FIELD_MANAGER, force: true };
    // LimitRange before the quota: the CPU/memory quota then applies to pods with no explicit requests.
    await this.core.patchNamespacedLimitRange(
      { name: "env-defaults", namespace, body: limitRangeObject(namespace), ...apply },
      ssa,
    );
    await this.core.patchNamespacedResourceQuota(
      { name: "env-quota", namespace, body: resourceQuotaObject(namespace, quota), ...apply },
      ssa,
    );
  }

  async getStatus({ name, namespace }: WorkloadRef): Promise<WorkloadStatus | null> {
    let deployment: k8s.V1Deployment;
    try {
      deployment = await this.apps.readNamespacedDeployment({ name, namespace });
    } catch (err) {
      if (statusOf(err) === 404) return null;
      throw err;
    }

    const template = deployment.spec?.template;
    const hash = template?.metadata?.labels?.[LABEL_SPEC_HASH];
    if (!hash) throw new Error(`deployment ${namespace}/${name} is missing ${LABEL_SPEC_HASH} on the template`);

    // Only pods of this spec count as ready. Pods from a previous version, still standing during the rollout, don't.
    const pods = await this.core.listNamespacedPod({
      namespace,
      labelSelector: `${LABEL_WORKLOAD}=${name},${LABEL_SPEC_HASH}=${hash}`,
    });
    return {
      image: template?.spec?.containers[0]?.image ?? "",
      replicas: deployment.spec?.replicas ?? 1,
      readyReplicas: pods.items.filter(isPodReady).length,
    };
  }
}

export function isPodReady(pod: k8s.V1Pod): boolean {
  if (pod.metadata?.deletionTimestamp) return false;
  return pod.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True") ?? false;
}

// The client throws errors with the status in `statusCode`, `response.statusCode` or `code`, depending on the version.
function statusOf(err: unknown): number | undefined {
  const e = err as { statusCode?: number; code?: number; response?: { statusCode?: number } };
  return e.statusCode ?? e.response?.statusCode ?? e.code;
}

function namespaceObject(namespace: string, labels: Record<string, string> = { "pod-security.kubernetes.io/enforce": "restricted" }): k8s.V1Namespace {
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: namespace, labels },
  };
}

function secretObject(spec: WorkloadSpec, secretName: string): k8s.V1Secret {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: secretName, namespace: spec.namespace, labels: { [LABEL_WORKLOAD]: spec.name } },
    type: "Opaque",
    stringData: spec.env,
  };
}

function deploymentObject(spec: WorkloadSpec, hash: string, secretName: string): k8s.V1Deployment {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: spec.name, namespace: spec.namespace, labels: { [LABEL_WORKLOAD]: spec.name } },
    spec: {
      replicas: spec.replicas,
      // The selector is immutable in Kubernetes: it stays with just the workload name, without the hash.
      selector: { matchLabels: { [LABEL_WORKLOAD]: spec.name } },
      template: {
        metadata: { labels: { [LABEL_WORKLOAD]: spec.name, [LABEL_SPEC_HASH]: hash } },
        spec: {
          securityContext: { runAsNonRoot: true, seccompProfile: { type: "RuntimeDefault" } },
          containers: [
            {
              name: "app",
              image: spec.image,
              ports: [{ containerPort: CONTAINER_PORT }],
              envFrom: [{ secretRef: { name: secretName } }],
              readinessProbe: { tcpSocket: { port: CONTAINER_PORT }, periodSeconds: 2 },
              // FS isn't read-only: user images often write outside of /tmp.
              securityContext: {
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
              },
              volumeMounts: [{ name: "tmp", mountPath: "/tmp" }],
            },
          ],
          volumes: [{ name: "tmp", emptyDir: {} }],
        },
      },
    },
  };
}
