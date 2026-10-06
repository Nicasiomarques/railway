import { PassThrough } from "node:stream";
import * as k8s from "@kubernetes/client-node";
import { CONTAINER_PORT, specHash, type RuntimeAdapter, type WorkloadRef, type WorkloadSpec, type WorkloadStatus } from "./adapter.js";
import {
  defaultDenyPolicy,
  limitRangeObject,
  PROVISIONER_FIELD_MANAGER,
  resourceQuotaObject,
  workloadEgressDnsPolicy,
  workloadIngressPolicy,
  type EnvironmentQuota,
  type EnvironmentRuntime,
} from "./environment.js";

export { CONTAINER_PORT };

// All objects are applied with server-side apply under the same field manager: applying again is idempotent
// and fields removed from the spec leave the cluster.
const FIELD_MANAGER = "railway-like-reconciler";
const LABEL_WORKLOAD = "platform/workload";
const LABEL_SPEC_HASH = "platform/spec-hash";

export class K8sRuntime implements RuntimeAdapter, EnvironmentRuntime {
  private readonly core: k8s.CoreV1Api;
  private readonly apps: k8s.AppsV1Api;
  private readonly net: k8s.NetworkingV1Api;
  private readonly autoscaling: k8s.AutoscalingV2Api;
  private readonly logClient: k8s.Log;

  constructor(kubeconfig: k8s.KubeConfig) {
    this.core = kubeconfig.makeApiClient(k8s.CoreV1Api);
    this.apps = kubeconfig.makeApiClient(k8s.AppsV1Api);
    this.net = kubeconfig.makeApiClient(k8s.NetworkingV1Api);
    this.autoscaling = kubeconfig.makeApiClient(k8s.AutoscalingV2Api);
    this.logClient = new k8s.Log(kubeconfig);
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
    await this.core.patchNamespacedService(
      { name: spec.name, namespace: spec.namespace, body: serviceObject(spec), ...apply },
      ssa,
    );
    await this.applyAutoscaler(spec);
  }

  // With a policy: upserts a HorizontalPodAutoscaler targeting this Deployment, server-side-applied
  // under the same field manager as everything else here -- same pattern as applyWorkload itself.
  // Without one: deletes any HPA left over from autoscaling having been turned off, so `spec.replicas`
  // (set directly on the Deployment by deploymentObject below) takes back control, instead of a
  // stale HPA re-scaling the workload on its own on its next reconcile loop.
  private async applyAutoscaler(spec: WorkloadSpec): Promise<void> {
    if (!spec.autoscaling) {
      try {
        await this.autoscaling.deleteNamespacedHorizontalPodAutoscaler({ name: spec.name, namespace: spec.namespace });
      } catch (err) {
        if (statusOf(err) !== 404) throw err;
      }
      return;
    }

    const ssa = k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.ServerSideApply);
    await this.autoscaling.patchNamespacedHorizontalPodAutoscaler(
      {
        name: spec.name,
        namespace: spec.namespace,
        body: horizontalPodAutoscalerObject(spec, spec.autoscaling),
        fieldManager: FIELD_MANAGER,
        force: true,
      },
      ssa,
    );
  }

  // Own field manager: the reconciler and the provisioner can write labels to the same namespace without erasing each other's.
  async ensureNamespace(namespace: string, labels: Record<string, string>): Promise<void> {
    const ssa = k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.ServerSideApply);
    const body = namespaceObject(namespace, labels);
    await this.core.patchNamespace({ name: namespace, body, fieldManager: PROVISIONER_FIELD_MANAGER, force: true }, ssa);
  }

  // Applies the full network policy set for the environment, not just the deny: a bare default-deny
  // would leave every workload unreachable (no ingress) and unable to resolve DNS (no egress), so the
  // allowances the comment on defaultDenyPolicy promises ("come later, via their own policy") are
  // applied right here, same field manager, same call site (the provisioning saga calls this once
  // per environment -- see provisioning/saga.ts).
  async applyDefaultDenyPolicy(namespace: string): Promise<void> {
    const ssa = k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.ServerSideApply);
    const apply = { fieldManager: PROVISIONER_FIELD_MANAGER, force: true };
    await this.net.patchNamespacedNetworkPolicy({ name: "default-deny", namespace, body: defaultDenyPolicy(namespace), ...apply }, ssa);
    await this.net.patchNamespacedNetworkPolicy(
      { name: "workload-ingress", namespace, body: workloadIngressPolicy(namespace), ...apply },
      ssa,
    );
    await this.net.patchNamespacedNetworkPolicy(
      { name: "workload-egress-dns", namespace, body: workloadEgressDnsPolicy(namespace), ...apply },
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

  // Idempotent: the namespace may already be gone (a previous attempt succeeded but the job was
  // retried, or it was never provisioned in the first place) -- a 404 is not an error here.
  async deleteNamespace(namespace: string): Promise<void> {
    try {
      await this.core.deleteNamespace({ name: namespace });
    } catch (err) {
      if (statusOf(err) === 404) return;
      throw err;
    }
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

  // Direct pod tail via a `kubectl logs`-equivalent (follow: true); no Loki/Vector pipeline in the
  // MVP (architecture.md §9). No replica to read from: nothing to do, ends with no lines.
  async *tailLogs({ name, namespace }: WorkloadRef, opts: { since?: string } = {}): AsyncIterable<string> {
    const pods = await this.core.listNamespacedPod({ namespace, labelSelector: `${LABEL_WORKLOAD}=${name}` });
    // Prefers a ready pod; failing that, the first one available (it could be crashing, in which
    // case those logs are exactly what you want to see).
    const pod = pods.items.find(isPodReady) ?? pods.items[0];
    const podName = pod?.metadata?.name;
    if (!podName) return;
    const container = pod.spec?.containers[0]?.name ?? "app";

    const stream = new PassThrough();
    const controller = await this.logClient.log(namespace, podName, container, stream, {
      follow: true,
      ...(opts.since ? { sinceTime: opts.since } : {}),
    });
    try {
      // The stream arrives in arbitrary chunks; split it into lines and keep the incomplete remainder for the next chunk.
      let pending = "";
      for await (const chunk of stream) {
        pending += (chunk as Buffer).toString("utf8");
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) yield line;
      }
      if (pending.length > 0) yield pending;
    } finally {
      controller.abort();
    }
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
      // With an autoscaling policy, `replicas` is left unset entirely (not even set to the current
      // count) so this field manager stops owning it under server-side apply, and the
      // HorizontalPodAutoscaler applied alongside it (applyAutoscaler) can own it instead -- setting
      // it here on every applyWorkload call (e.g. a redeploy) would otherwise reset the HPA's scaling
      // decision every time.
      ...(spec.autoscaling ? {} : { replicas: spec.replicas }),
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
              // A CPU request is required for the HPA's utilization-percent target to mean anything
              // (it's a percentage of this number); only set when autoscaling is actually on.
              ...(spec.autoscaling
                ? { resources: { requests: { cpu: `${spec.autoscaling.cpuRequestMillicores}m` } } }
                : {}),
            },
          ],
          volumes: [{ name: "tmp", emptyDir: {} }],
        },
      },
    },
  };
}

// ClusterIP: reachable from other pods (Connections, same-namespace calls) and from `kubectl
// port-forward` without any ingress controller or public DNS -- enough to validate "ver no ar"
// fully offline. A real external route (NodePort/LoadBalancer/Ingress + DNS/TLS) is a separate,
// later concern (the domain/edge feature), not this adapter's job.
function serviceObject(spec: WorkloadSpec): k8s.V1Service {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: spec.name, namespace: spec.namespace, labels: { [LABEL_WORKLOAD]: spec.name } },
    spec: {
      selector: { [LABEL_WORKLOAD]: spec.name },
      ports: [{ port: CONTAINER_PORT, targetPort: CONTAINER_PORT, protocol: "TCP" }],
    },
  };
}

function horizontalPodAutoscalerObject(spec: WorkloadSpec, policy: NonNullable<WorkloadSpec["autoscaling"]>): k8s.V2HorizontalPodAutoscaler {
  return {
    apiVersion: "autoscaling/v2",
    kind: "HorizontalPodAutoscaler",
    metadata: { name: spec.name, namespace: spec.namespace, labels: { [LABEL_WORKLOAD]: spec.name } },
    spec: {
      scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name: spec.name },
      minReplicas: policy.minReplicas,
      maxReplicas: policy.maxReplicas,
      metrics: [
        {
          type: "Resource",
          resource: { name: "cpu", target: { type: "Utilization", averageUtilization: policy.targetCpuPercent } },
        },
      ],
    },
  };
}
