import * as k8s from "@kubernetes/client-node";
import type { BuildRequest, BuildStatus, Builder } from "./builder.js";
import { detectorSource } from "./detector-source.js";

// Imagens fixadas por digest (reprodutível). BuildKit rootless roda como usuário 1000.
export const GIT_IMAGE = "alpine/git@sha256:062a01ad7a0eb17cff382bc5e26086b4d710e56dfdfdf001109a49b6d9bd378c";
export const NODE_IMAGE = "node@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402";
export const CURL_IMAGE = "curlimages/curl@sha256:c1fe1679c34d9784c1b0d1e5f62ac0a79fca01fb6377cdd33e90473c6f9f9a69";
export const BUILDKIT_IMAGE = "moby/buildkit@sha256:f8a833b2de9d68e27f0815e4a737abdfaf8a2e4c615650557df11025101557b4";

export interface K8sBuilderConfig {
  // Registry que recebe as imagens, como os nós e os pods o enxergam: ex. `k3d-railway-reg:5000`.
  registry: string;
  namespace: string;
  // Tempo máximo de um build. Acima disso o Job é encerrado pelo próprio cluster.
  timeoutSeconds: number;
  // Sandbox de processo do BuildKit para os RUN. "process" isola cada RUN (exige montar /proc e pid namespace,
  // o que o pod atual não consegue). "none" roda os RUN sem esse sandbox: o único modo que funciona hoje, com
  // isolamento entre RUNs reduzido. O isolamento real (gVisor/microVM) substitui esta escolha.
  processSandbox: "process" | "none";
  // Flags extras do buildkitd (ex.: snapshotter nativo, que o gVisor suporta; overlay com FUSE não).
  buildkitdFlags?: string;
  // RuntimeClass do pod de build. "gvisor" roda o build num kernel de usuário (sandbox real); vazio usa o runtime padrão.
  runtimeClass?: string;
  // Saídas liberadas explicitamente para dentro de redes privadas (ex.: o registry e o host do repo de teste).
  // O resto das redes privadas e o endpoint de metadados ficam bloqueados.
  egressAllow: { cidr: string; port: number }[];
}

// Redes que um build nunca alcança: pods, serviços e nós do cluster, a rede interna, e metadados de nuvem.
const PRIVATE_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"];

const LABEL_DEPLOYMENT = "railway.build/deployment";
// Limite do retrato salvo: o fim do log é o que importa para diagnosticar uma falha.
const MAX_LOG_CHARS = 256 * 1024;
const LOG_CONTAINERS = ["egress-gate", "clone", "detect", "build"] as const;
const FIELD_MANAGER = "railway-like-reconciler";
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export class K8sBuilder implements Builder {
  private readonly core: k8s.CoreV1Api;
  private readonly batch: k8s.BatchV1Api;
  private readonly networking: k8s.NetworkingV1Api;

  constructor(
    kubeconfig: k8s.KubeConfig,
    private readonly cfg: K8sBuilderConfig,
  ) {
    this.core = kubeconfig.makeApiClient(k8s.CoreV1Api);
    this.batch = kubeconfig.makeApiClient(k8s.BatchV1Api);
    this.networking = kubeconfig.makeApiClient(k8s.NetworkingV1Api);
  }

  static fromContext(context: string | undefined, cfg: K8sBuilderConfig): K8sBuilder {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    if (context) kc.setCurrentContext(context);
    return new K8sBuilder(kc, cfg);
  }

  async start(req: BuildRequest): Promise<void> {
    await this.ensureNamespace();
    try {
      await this.batch.createNamespacedJob({ namespace: this.cfg.namespace, body: this.jobObject(req) });
    } catch (err) {
      // 409: o Job já existe, de uma tentativa anterior. Nada a fazer.
      if (statusOf(err) !== 409) throw err;
    }
  }

  async status(req: Pick<BuildRequest, "deploymentId" | "serviceInstanceId">): Promise<BuildStatus> {
    const name = jobName(req.deploymentId);
    let job: k8s.V1Job;
    try {
      job = await this.batch.readNamespacedJob({ name, namespace: this.cfg.namespace });
    } catch (err) {
      if (statusOf(err) === 404) return { kind: "failed", reason: "Job de build não encontrado (expirou ou foi removido)" };
      throw err;
    }

    const pod = await this.buildPod(name);
    if ((job.status?.succeeded ?? 0) > 0) {
      const digest = pod?.status?.containerStatuses?.find((c) => c.name === "build")?.state?.terminated?.message?.trim();
      if (!digest || !DIGEST.test(digest)) return { kind: "failed", reason: "build concluiu sem digest válido" };
      return { kind: "succeeded", imageDigest: `${this.imageName(req.serviceInstanceId)}@${digest}` };
    }
    if ((job.status?.failed ?? 0) > 0) {
      const timeout = job.status?.conditions?.find((c) => c.type === "Failed" && c.reason === "DeadlineExceeded");
      if (timeout) return { kind: "failed", reason: `build excedeu ${this.cfg.timeoutSeconds}s` };
      const initFailure = pod?.status?.initContainerStatuses?.find((c) => (c.state?.terminated?.exitCode ?? 0) !== 0);
      if (initFailure) {
        return { kind: "failed", reason: `etapa ${initFailure.name} falhou (código ${initFailure.state?.terminated?.exitCode})` };
      }
      const terminated = pod?.status?.containerStatuses?.find((c) => c.name === "build")?.state?.terminated;
      return { kind: "failed", reason: `build falhou (código ${terminated?.exitCode ?? "desconhecido"})` };
    }
    return { kind: "running" };
  }

  async logs(req: Pick<BuildRequest, "deploymentId" | "serviceInstanceId">): Promise<string> {
    const pod = await this.buildPod(jobName(req.deploymentId));
    const podName = pod?.metadata?.name;
    if (!podName) return "";

    const parts: string[] = [];
    for (const container of LOG_CONTAINERS) {
      try {
        const text = await this.core.readNamespacedPodLog({ name: podName, namespace: this.cfg.namespace, container, tailLines: 2000 });
        if (text.trim()) parts.push(`=== ${container} ===\n${text.trimEnd()}`);
      } catch {
        // Container que ainda não começou não tem log: não é erro.
      }
    }
    return parts.join("\n\n").slice(-MAX_LOG_CHARS);
  }

  async cancel(req: Pick<BuildRequest, "deploymentId" | "serviceInstanceId">): Promise<void> {
    try {
      // Background: o Job some na hora e os pods são coletados pelo cluster.
      await this.batch.deleteNamespacedJob({
        name: jobName(req.deploymentId),
        namespace: this.cfg.namespace,
        propagationPolicy: "Background",
      });
    } catch (err) {
      if (statusOf(err) !== 404) throw err;
    }
  }

  private imageName(serviceInstanceId: string): string {
    return `${this.cfg.registry}/workloads/${serviceInstanceId}`;
  }

  private async buildPod(jobName: string): Promise<k8s.V1Pod | undefined> {
    const pods = await this.core.listNamespacedPod({ namespace: this.cfg.namespace, labelSelector: `job-name=${jobName}` });
    return pods.items[0];
  }

  private async ensureNamespace(): Promise<void> {
    // Builds precisam de seccomp Unconfined (BuildKit rootless cria user namespaces); o perfil restricted
    // não permite. Esta é a principal concessão até o isolamento do build sair do spike (microVM / gVisor).
    const body: k8s.V1Namespace = {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: this.cfg.namespace, labels: { "pod-security.kubernetes.io/enforce": "privileged" } },
    };
    const ssa = k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.ServerSideApply);
    await this.core.patchNamespace({ name: this.cfg.namespace, body, fieldManager: FIELD_MANAGER, force: true }, ssa);
    await this.applyEgressPolicy();
  }

  // Default-deny de ingress, e egress só para DNS, internet pública e as saídas explicitamente liberadas.
  private async applyEgressPolicy(): Promise<void> {
    const body: k8s.V1NetworkPolicy = {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "build-egress", namespace: this.cfg.namespace },
      spec: {
        podSelector: {},
        policyTypes: ["Ingress", "Egress"],
        ingress: [],
        egress: [
          {
            to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } } }],
            ports: [
              { port: 53, protocol: "UDP" },
              { port: 53, protocol: "TCP" },
            ],
          },
          { to: [{ ipBlock: { cidr: "0.0.0.0/0", except: PRIVATE_RANGES } }] },
          ...this.cfg.egressAllow.map((a) => ({
            to: [{ ipBlock: { cidr: a.cidr } }],
            ports: [{ port: a.port, protocol: "TCP" }],
          })),
        ],
      },
    };
    await this.networking.patchNamespacedNetworkPolicy(
      { name: "build-egress", namespace: this.cfg.namespace, body, fieldManager: FIELD_MANAGER, force: true },
      k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.ServerSideApply),
    );
  }

  private jobObject(req: BuildRequest): k8s.V1Job {
    const subdir = req.rootDir.replace(/^\/+|\/+$/g, "");
    const contextPath = subdir ? `/work/src/${subdir}` : "/work/src";
    const image = `${this.imageName(req.serviceInstanceId)}:${req.deploymentId}`;
    const labels = { [LABEL_DEPLOYMENT]: req.deploymentId };

    return {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: { name: jobName(req.deploymentId), namespace: this.cfg.namespace, labels },
      spec: {
        backoffLimit: 0,
        activeDeadlineSeconds: this.cfg.timeoutSeconds,
        ttlSecondsAfterFinished: 3600,
        template: {
          metadata: { labels },
          spec: {
            restartPolicy: "Never",
            ...(this.cfg.runtimeClass ? { runtimeClassName: this.cfg.runtimeClass } : {}),
            securityContext: {
              runAsUser: 1000,
              runAsGroup: 1000,
              seccompProfile: { type: "Unconfined" },
            },
            volumes: [{ name: "work", emptyDir: {} }],
            initContainers: [
              {
                // Gate: a política de egress não vale no primeiro instante do pod (o kube-router a programa com
                // alguns segundos de atraso). Só deixa o build seguir quando a API do cluster, que a política bloqueia,
                // para de responder. Se isso não acontecer em 60s, falha fechado.
                name: "egress-gate",
                image: CURL_IMAGE,
                command: ["sh", "-c", EGRESS_GATE_SCRIPT],
                securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
              },
              {
                name: "clone",
                image: GIT_IMAGE,
                // Valores por env, nunca interpolados no shell: URL e SHA não podem injetar comandos.
                command: ["sh", "-c", 'git clone "$REPO_URL" /work/src && cd /work/src && git checkout "$COMMIT_SHA"'],
                env: [
                  { name: "REPO_URL", value: req.repoUrl },
                  { name: "COMMIT_SHA", value: req.commitSha },
                ],
                volumeMounts: [{ name: "work", mountPath: "/work" }],
                securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
              },
              {
                // Detecta a stack do repo (ou usa o Dockerfile dele) e grava o Dockerfile em /work/build.
                // Stack desconhecida sai com código 2; a justificativa fica nos logs.
                name: "detect",
                image: NODE_IMAGE,
                command: ["sh", "-c", 'echo "$DETECTOR_B64" | base64 -d > /work/detector.mjs && mkdir -p /work/build && node /work/detector.mjs /work/src "$ROOT_DIR" /work/build'],
                env: [
                  { name: "DETECTOR_B64", value: Buffer.from(detectorSource()).toString("base64") },
                  { name: "ROOT_DIR", value: subdir },
                ],
                volumeMounts: [{ name: "work", mountPath: "/work" }],
                securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
              },
            ],
            containers: [
              {
                name: "build",
                image: BUILDKIT_IMAGE,
                command: ["sh", "-c", BUILD_SCRIPT],
                volumeMounts: [{ name: "work", mountPath: "/work" }],
                env: [
                  { name: "CONTEXT_PATH", value: contextPath },
                  { name: "IMAGE", value: image },
                  { name: "BUILDKITD_FLAGS", value: buildkitdFlags(this.cfg) },
                ],
                resources: { limits: { cpu: "2", memory: "4Gi" } },
                // Concessões do BuildKit rootless: newuidmap é setuid, então a escalada precisa estar liberada
                // e as capabilities não podem ser descartadas. Sem isso o build não sobe o daemon.
                securityContext: { allowPrivilegeEscalation: true },
              },
            ],
          },
        },
      },
    };
  }
}

// Bloqueado = a conexão falha por recusa (curl 7) ou timeout (curl 28), que é como a política aparece no cluster.
// Alcançável = HTTP qualquer (curl 0). Falha de DNS (6) ou de sintaxe não conta como bloqueio: o gate continua
// esperando e, no fim, falha fechado.
// KUBERNETES_SERVICE_HOST é injetado em todo pod, então não depende de resolver nome.
const EGRESS_GATE_SCRIPT = [
  "for i in $(seq 1 60); do",
  '  curl -sk -m 3 -o /dev/null "https://$KUBERNETES_SERVICE_HOST:$KUBERNETES_SERVICE_PORT/version"',
  "  rc=$?",
  '  if [ "$rc" = 7 ] || [ "$rc" = 28 ]; then echo "política de egress ativa (API do cluster inacessível: curl $rc)"; exit 0; fi',
  "  sleep 1",
  "done",
  "echo \"política de egress não ficou ativa em 60s (último código curl: $rc)\" >&2; exit 1",
].join("\n");

// Build e push; o digest sai pelo termination message, que o worker lê via API.
const BUILD_SCRIPT = [
  'buildctl-daemonless.sh build --frontend dockerfile.v0',
  '--local context="$CONTEXT_PATH" --local dockerfile=/work/build --opt filename=Dockerfile',
  '--output type=image,name="$IMAGE",push=true,registry.insecure=true --metadata-file /work/meta.json',
  '&& sed -n \'s/.*"containerimage.digest": *"\\([^"]*\\)".*/\\1/p\' /work/meta.json > /dev/termination-log',
].join(" ");

function buildkitdFlags(cfg: K8sBuilderConfig): string {
  const flags = [cfg.processSandbox === "none" ? "--oci-worker-no-process-sandbox" : "", cfg.buildkitdFlags ?? ""];
  return flags.filter(Boolean).join(" ");
}

function jobName(deploymentId: string): string {
  return `build-${deploymentId}`;
}

function statusOf(err: unknown): number | undefined {
  const e = err as { statusCode?: number; code?: number; response?: { statusCode?: number } };
  return e.statusCode ?? e.response?.statusCode ?? e.code;
}
