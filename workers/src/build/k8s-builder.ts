import * as k8s from "@kubernetes/client-node";
import type { BuildRequest, BuildStatus, Builder } from "./builder.js";
import { detectorSource } from "./detector-source.js";

// Images pinned by digest (reproducible). Rootless BuildKit runs as user 1000.
export const GIT_IMAGE = "alpine/git@sha256:062a01ad7a0eb17cff382bc5e26086b4d710e56dfdfdf001109a49b6d9bd378c";
export const NODE_IMAGE = "node@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402";
export const CURL_IMAGE = "curlimages/curl@sha256:c1fe1679c34d9784c1b0d1e5f62ac0a79fca01fb6377cdd33e90473c6f9f9a69";
export const BUILDKIT_IMAGE = "moby/buildkit@sha256:f8a833b2de9d68e27f0815e4a737abdfaf8a2e4c615650557df11025101557b4";

export interface K8sBuilderConfig {
  // Registry that receives the images, as seen by the nodes and pods: e.g. `k3d-railway-reg:5000`.
  registry: string;
  namespace: string;
  // Maximum time for a build. Beyond that, the Job is terminated by the cluster itself.
  timeoutSeconds: number;
  // BuildKit process sandbox for RUNs. "process" isolates each RUN (requires mounting /proc and a pid
  // namespace, which the current pod can't do). "none" runs RUNs without that sandbox: the only mode
  // that works today, with reduced isolation between RUNs. Real isolation (gVisor/microVM) replaces this choice.
  processSandbox: "process" | "none";
  // Extra buildkitd flags (e.g. the native snapshotter, which gVisor supports; FUSE overlay does not).
  buildkitdFlags?: string;
  // RuntimeClass for the build pod. "gvisor" runs the build in a user-space kernel (real sandbox); empty uses the default runtime.
  runtimeClass?: string;
  // Outbound destinations explicitly allowed into private networks (e.g. the registry and the test repo host).
  // The rest of the private networks and the metadata endpoint remain blocked.
  egressAllow: { cidr: string; port: number }[];
}

// Networks a build can never reach: cluster pods, services and nodes, the internal network, and cloud metadata.
const PRIVATE_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"];

const LABEL_DEPLOYMENT = "railway.build/deployment";
// Limit on the saved snapshot: the end of the log is what matters for diagnosing a failure.
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
      // 409: the Job already exists, from a previous attempt. Nothing to do.
      if (statusOf(err) !== 409) throw err;
    }
  }

  async status(req: Pick<BuildRequest, "deploymentId" | "serviceInstanceId">): Promise<BuildStatus> {
    const name = jobName(req.deploymentId);
    let job: k8s.V1Job;
    try {
      job = await this.batch.readNamespacedJob({ name, namespace: this.cfg.namespace });
    } catch (err) {
      if (statusOf(err) === 404) return { kind: "failed", reason: "build Job not found (expired or removed)" };
      throw err;
    }

    const pod = await this.buildPod(name);
    if ((job.status?.succeeded ?? 0) > 0) {
      const digest = pod?.status?.containerStatuses?.find((c) => c.name === "build")?.state?.terminated?.message?.trim();
      if (!digest || !DIGEST.test(digest)) return { kind: "failed", reason: "build finished without a valid digest" };
      return { kind: "succeeded", imageDigest: `${this.imageName(req.serviceInstanceId)}@${digest}` };
    }
    if ((job.status?.failed ?? 0) > 0) {
      const timeout = job.status?.conditions?.find((c) => c.type === "Failed" && c.reason === "DeadlineExceeded");
      if (timeout) return { kind: "failed", reason: `build exceeded ${this.cfg.timeoutSeconds}s` };
      const initFailure = pod?.status?.initContainerStatuses?.find((c) => (c.state?.terminated?.exitCode ?? 0) !== 0);
      if (initFailure) {
        return { kind: "failed", reason: `stage ${initFailure.name} failed (code ${initFailure.state?.terminated?.exitCode})` };
      }
      const terminated = pod?.status?.containerStatuses?.find((c) => c.name === "build")?.state?.terminated;
      return { kind: "failed", reason: `build failed (code ${terminated?.exitCode ?? "unknown"})` };
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
        // A container that hasn't started yet has no log: not an error.
      }
    }
    return parts.join("\n\n").slice(-MAX_LOG_CHARS);
  }

  async cancel(req: Pick<BuildRequest, "deploymentId" | "serviceInstanceId">): Promise<void> {
    try {
      // Background: the Job disappears immediately and the pods are garbage-collected by the cluster.
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
    // Builds need seccomp Unconfined (rootless BuildKit creates user namespaces); the restricted profile
    // doesn't allow it. This is the main concession until build isolation moves past the spike (microVM / gVisor).
    const body: k8s.V1Namespace = {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: this.cfg.namespace, labels: { "pod-security.kubernetes.io/enforce": "privileged" } },
    };
    const ssa = k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.ServerSideApply);
    await this.core.patchNamespace({ name: this.cfg.namespace, body, fieldManager: FIELD_MANAGER, force: true }, ssa);
    await this.applyEgressPolicy();
  }

  // Default-deny for ingress, and egress only to DNS, the public internet, and the explicitly allowed destinations.
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
                // Gate: the egress policy doesn't take effect the instant the pod starts (kube-router programs it
                // with a few seconds of delay). Only lets the build proceed once the cluster API, which the policy
                // blocks, stops responding. If that doesn't happen within 60s, it fails closed.
                name: "egress-gate",
                image: CURL_IMAGE,
                command: ["sh", "-c", EGRESS_GATE_SCRIPT],
                securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
              },
              {
                name: "clone",
                image: GIT_IMAGE,
                // Values passed via env, never interpolated into the shell: URL and SHA can't inject commands.
                command: ["sh", "-c", 'git clone "$REPO_URL" /work/src && cd /work/src && git checkout "$COMMIT_SHA"'],
                env: [
                  { name: "REPO_URL", value: req.repoUrl },
                  { name: "COMMIT_SHA", value: req.commitSha },
                ],
                volumeMounts: [{ name: "work", mountPath: "/work" }],
                securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
              },
              {
                // Detects the repo's stack (or uses its Dockerfile) and writes the Dockerfile to /work/build.
                // An unknown stack exits with code 2; the justification ends up in the logs.
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
                // Rootless BuildKit concessions: newuidmap is setuid, so privilege escalation must be allowed
                // and capabilities can't be dropped. Without this the build can't start the daemon.
                securityContext: { allowPrivilegeEscalation: true },
              },
            ],
          },
        },
      },
    };
  }
}

// Blocked = the connection fails with a refusal (curl 7) or timeout (curl 28), which is how the policy
// shows up on the cluster. Reachable = any HTTP response (curl 0). A DNS (6) or syntax failure doesn't
// count as blocked: the gate keeps waiting and, in the end, fails closed.
// KUBERNETES_SERVICE_HOST is injected into every pod, so it doesn't depend on name resolution.
const EGRESS_GATE_SCRIPT = [
  "for i in $(seq 1 60); do",
  '  curl -sk -m 3 -o /dev/null "https://$KUBERNETES_SERVICE_HOST:$KUBERNETES_SERVICE_PORT/version"',
  "  rc=$?",
  '  if [ "$rc" = 7 ] || [ "$rc" = 28 ]; then echo "egress policy active (cluster API unreachable: curl $rc)"; exit 0; fi',
  "  sleep 1",
  "done",
  "echo \"egress policy did not become active within 60s (last curl code: $rc)\" >&2; exit 1",
].join("\n");

// Build and push; the digest comes out via the termination message, which the worker reads through the API.
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
