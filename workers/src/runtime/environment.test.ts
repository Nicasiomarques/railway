import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENV_QUOTA,
  defaultDenyPolicy,
  limitRangeObject,
  resourceQuotaObject,
  workloadEgressDnsPolicy,
  workloadIngressPolicy,
} from "./environment.js";

describe("environment manifests", () => {
  it("default-deny denies ingress and egress for every pod in the namespace", () => {
    const policy = defaultDenyPolicy("env-x");

    expect(policy.metadata).toEqual({ name: "default-deny", namespace: "env-x" });
    expect(policy.spec).toEqual({ podSelector: {}, policyTypes: ["Ingress", "Egress"] });
  });

  it("workload-ingress allows traffic to the workload port from any source, for every pod in the namespace", () => {
    const policy = workloadIngressPolicy("env-x");

    expect(policy.metadata).toEqual({ name: "workload-ingress", namespace: "env-x" });
    expect(policy.spec).toEqual({
      podSelector: {},
      policyTypes: ["Ingress"],
      ingress: [{ ports: [{ port: 8080, protocol: "TCP" }] }],
    });
  });

  it("workload-egress-dns allows only DNS to kube-system, for every pod in the namespace", () => {
    const policy = workloadEgressDnsPolicy("env-x");

    expect(policy.metadata).toEqual({ name: "workload-egress-dns", namespace: "env-x" });
    expect(policy.spec).toEqual({
      podSelector: {},
      policyTypes: ["Egress"],
      egress: [
        {
          to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } } }],
          ports: [
            { port: 53, protocol: "UDP" },
            { port: 53, protocol: "TCP" },
          ],
        },
      ],
    });
  });

  it("quota converts the limits to strings and pods to a numeric string", () => {
    const quota = resourceQuotaObject("env-x", DEFAULT_ENV_QUOTA);

    expect(quota.spec?.hard).toEqual({
      "requests.cpu": "2",
      "requests.memory": "4Gi",
      "limits.cpu": "4",
      "limits.memory": "8Gi",
      pods: "20",
    });
  });

  it("LimitRange sets default requests and limits per container, so the quota accepts pods with no explicit resources", () => {
    const range = limitRangeObject("env-x");
    const item = range.spec?.limits?.[0];

    expect(item?.type).toBe("Container");
    expect(item?.defaultRequest).toEqual({ cpu: "100m", memory: "128Mi" });
    expect(item?.default).toEqual({ cpu: "500m", memory: "512Mi" });
  });
});
