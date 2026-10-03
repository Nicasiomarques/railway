import { PassThrough } from "node:stream";
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

// Porta em que o app escuta. Fixa nesta fase: o contrato de serviço ainda não tem porta configurável.
export const CONTAINER_PORT = 8080;

// Todos os objetos são aplicados com server-side apply sob o mesmo field manager: aplicar de novo é idempotente
// e campos removidos da spec saem do cluster.
const FIELD_MANAGER = "railway-like-reconciler";
const LABEL_WORKLOAD = "platform/workload";
const LABEL_SPEC_HASH = "platform/spec-hash";

export class K8sRuntime implements RuntimeAdapter, EnvironmentRuntime {
  private readonly core: k8s.CoreV1Api;
  private readonly apps: k8s.AppsV1Api;
  private readonly net: k8s.NetworkingV1Api;
  private readonly logClient: k8s.Log;

  constructor(kubeconfig: k8s.KubeConfig) {
    this.core = kubeconfig.makeApiClient(k8s.CoreV1Api);
    this.apps = kubeconfig.makeApiClient(k8s.AppsV1Api);
    this.net = kubeconfig.makeApiClient(k8s.NetworkingV1Api);
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
  }

  // Field manager próprio: o reconciliador e o provisionador podem gravar labels no mesmo namespace sem se apagarem.
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
    // LimitRange antes da quota: a quota de CPU/memória passa a valer para pods sem requests explícitos.
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
    if (!hash) throw new Error(`deployment ${namespace}/${name} sem ${LABEL_SPEC_HASH} no template`);

    // Só pods desta spec contam como prontos. Pods de uma versão anterior, ainda de pé no rollout, não.
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

  // Tail direto do pod via `kubectl logs`-equivalente (follow: true); sem pipeline Loki/Vector no MVP
  // (architecture.md §9). Sem réplica para ler, não há nada a fazer: encerra sem linhas.
  async *tailLogs({ name, namespace }: WorkloadRef, opts: { since?: string } = {}): AsyncIterable<string> {
    const pods = await this.core.listNamespacedPod({ namespace, labelSelector: `${LABEL_WORKLOAD}=${name}` });
    // Prioriza um pod pronto; na ausência de um, o primeiro disponível (pode estar crashando, e aí os logs
    // são exatamente o que se quer ver).
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
      // O stream chega em pedaços arbitrários; reparte em linhas e guarda o resto incompleto para o próximo pedaço.
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

// O cliente lança erros com o status em `statusCode`, `response.statusCode` ou `code`, conforme a versão.
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
      // O seletor é imutável no Kubernetes: fica só com o nome do workload, sem o hash.
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
              // FS não é somente leitura: imagens de usuário costumam escrever fora de /tmp.
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
