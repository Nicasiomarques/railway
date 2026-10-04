import { afterEach, describe, expect, it } from "vitest";
import { isTemplateSource, resolveTemplateImage } from "./templates.js";

describe("template sources", () => {
  it("recognizes the known template sources", () => {
    expect(isTemplateSource("postgres_template")).toBe(true);
    expect(isTemplateSource("redis_template")).toBe(true);
    expect(isTemplateSource("minio_template")).toBe(true);
  });

  it("does not treat other service sources as templates", () => {
    expect(isTemplateSource("github_repo")).toBe(false);
    expect(isTemplateSource("image")).toBe(false);
    expect(isTemplateSource("template")).toBe(false);
  });
});

describe("resolveTemplateImage", () => {
  afterEach(() => {
    delete process.env.MINIO_TEMPLATE_IMAGE_DIGEST;
  });

  it("resolves a pinned digest for postgres_template", () => {
    expect(resolveTemplateImage("postgres_template")).toMatch(/^docker\.io\/library\/postgres@sha256:[a-f0-9]{64}$/);
  });

  it("resolves a pinned digest for redis_template", () => {
    expect(resolveTemplateImage("redis_template")).toMatch(/^docker\.io\/library\/redis@sha256:[a-f0-9]{64}$/);
  });

  it("minio_template has no pinned digest by default", () => {
    expect(resolveTemplateImage("minio_template")).toBeNull();
  });

  it("minio_template uses MINIO_TEMPLATE_IMAGE_DIGEST when set", () => {
    process.env.MINIO_TEMPLATE_IMAGE_DIGEST = "registry.example.com/minio@sha256:" + "a".repeat(64);
    expect(resolveTemplateImage("minio_template")).toBe("registry.example.com/minio@sha256:" + "a".repeat(64));
  });

  it("returns null for a non-template source", () => {
    expect(resolveTemplateImage("image")).toBeNull();
    expect(resolveTemplateImage("github_repo")).toBeNull();
  });
});
