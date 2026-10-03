import type * as k8s from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import { isPodReady } from "./k8s.js";
import { specHash } from "./adapter.js";

const pod = (overrides: Partial<k8s.V1Pod> & { ready?: string }): k8s.V1Pod => ({
  metadata: overrides.metadata ?? {},
  status: { conditions: overrides.ready ? [{ type: "Ready", status: overrides.ready }] : [] },
});

describe("isPodReady", () => {
  it("pod com Ready=True está pronto", () => {
    expect(isPodReady(pod({ ready: "True" }))).toBe(true);
  });

  it("pod com Ready=False não está pronto", () => {
    expect(isPodReady(pod({ ready: "False" }))).toBe(false);
  });

  it("pod em terminação não conta, mesmo se ainda estiver Ready", () => {
    expect(isPodReady(pod({ ready: "True", metadata: { deletionTimestamp: new Date() } }))).toBe(false);
  });
});

describe("specHash", () => {
  it("é independente da ordem das variáveis", () => {
    expect(specHash({ image: "a@sha256:1", env: { A: "1", B: "2" } })).toBe(
      specHash({ image: "a@sha256:1", env: { B: "2", A: "1" } }),
    );
  });

  it("muda quando o env muda ou a imagem muda", () => {
    const base = specHash({ image: "a@sha256:1", env: { A: "1" } });
    expect(specHash({ image: "a@sha256:1", env: { A: "2" } })).not.toBe(base);
    expect(specHash({ image: "a@sha256:2", env: { A: "1" } })).not.toBe(base);
  });
});
