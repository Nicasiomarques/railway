import { describe, expect, it } from "vitest";
import { DEFAULT_ENV_QUOTA, defaultDenyPolicy, limitRangeObject, resourceQuotaObject } from "./environment.js";

describe("manifestos do ambiente", () => {
  it("default-deny nega ingress e egress de todos os pods do namespace", () => {
    const policy = defaultDenyPolicy("env-x");

    expect(policy.metadata).toEqual({ name: "default-deny", namespace: "env-x" });
    expect(policy.spec).toEqual({ podSelector: {}, policyTypes: ["Ingress", "Egress"] });
  });

  it("quota converte os limites para strings e pods para número em string", () => {
    const quota = resourceQuotaObject("env-x", DEFAULT_ENV_QUOTA);

    expect(quota.spec?.hard).toEqual({
      "requests.cpu": "2",
      "requests.memory": "4Gi",
      "limits.cpu": "4",
      "limits.memory": "8Gi",
      pods: "20",
    });
  });

  it("LimitRange define requests e limites padrão por contêiner, para a quota aceitar pods sem recursos explícitos", () => {
    const range = limitRangeObject("env-x");
    const item = range.spec?.limits?.[0];

    expect(item?.type).toBe("Container");
    expect(item?.defaultRequest).toEqual({ cpu: "100m", memory: "128Mi" });
    expect(item?.default).toEqual({ cpu: "500m", memory: "512Mi" });
  });
});
