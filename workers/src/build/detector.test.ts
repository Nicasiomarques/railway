import { describe, expect, it } from "vitest";
import { detect } from "./detector.mjs";

// Árvore em memória: cada teste descreve o repo como um mapa de arquivos.
function tree(files: Record<string, string>) {
  return {
    exists: (p: string) => p in files,
    read: (p: string) => (p in files ? files[p] : null),
  };
}

describe("detector de stack", () => {
  it("Dockerfile do repo tem prioridade e é usado como está", () => {
    const result = detect(tree({ Dockerfile: "FROM scratch\n", "package.json": "{}" }));
    expect(result.kind).toBe("dockerfile");
    expect(result.dockerfile).toBe("FROM scratch\n");
  });

  it("Node com lockfile npm e script start", () => {
    const result = detect(
      tree({
        "package.json": JSON.stringify({ engines: { node: ">=20" }, scripts: { start: "node server.js" } }),
        "package-lock.json": "{}",
        "server.js": "",
      }),
    );
    expect(result.kind).toBe("node");
    expect(result.dockerfile).toContain("FROM node:20-alpine");
    expect(result.dockerfile).toContain("RUN npm ci");
    expect(result.dockerfile).toContain('CMD ["npm","start"]');
    expect(result.dockerfile).toContain("USER 1000");
    expect(result.justification).toContain("package-lock.json → npm ci");
  });

  it("Node com pnpm usa corepack e frozen lockfile", () => {
    const result = detect(tree({ "package.json": JSON.stringify({ scripts: { start: "x" } }), "pnpm-lock.yaml": "" }));
    expect(result.dockerfile).toContain("RUN corepack enable && pnpm install --frozen-lockfile");
    expect(result.dockerfile).toContain('CMD ["pnpm","start"]');
  });

  it("Node sem engines usa a versão padrão e diz isso na justificativa", () => {
    const result = detect(tree({ "package.json": "{}", "index.js": "" }));
    expect(result.dockerfile).toContain("FROM node:22-alpine");
    expect(result.justification.join(" ")).toMatch(/sem engines.node/);
  });

  it("Node sem start usa main ou index.js como entrypoint", () => {
    const result = detect(tree({ "package.json": JSON.stringify({ main: "app.js" }), "app.js": "" }));
    expect(result.dockerfile).toContain('CMD ["node","app.js"]');
  });

  it("Node sem script nem entrypoint é unknown com motivo", () => {
    const result = detect(tree({ "package.json": "{}" }));
    expect(result.kind).toBe("unknown");
    expect(result.dockerfile).toBeNull();
    expect(result.justification.join(" ")).toMatch(/sem scripts.start/);
  });

  it("package.json inválido é unknown", () => {
    const result = detect(tree({ "package.json": "{ não é json" }));
    expect(result.kind).toBe("unknown");
    expect(result.justification.join(" ")).toMatch(/não é JSON válido/);
  });

  it("Python com requirements.txt e main.py", () => {
    const result = detect(tree({ "requirements.txt": "flask\n", "main.py": "" }));
    expect(result.kind).toBe("python");
    expect(result.dockerfile).toContain("FROM python:3.12-slim");
    expect(result.dockerfile).toContain("RUN pip install --no-cache-dir -r requirements.txt");
    expect(result.dockerfile).toContain('CMD ["python","main.py"]');
  });

  it("Python sem entrypoint reconhecido é unknown", () => {
    const result = detect(tree({ "requirements.txt": "flask\n" }));
    expect(result.kind).toBe("unknown");
  });

  it("Go usa a versão do go.mod e build multi-stage", () => {
    const result = detect(tree({ "go.mod": "module x\n\ngo 1.22\n", "main.go": "" }));
    expect(result.kind).toBe("go");
    expect(result.dockerfile).toContain("FROM golang:1.22-alpine AS build");
    expect(result.dockerfile).toContain("COPY --from=build /out/app /app");
  });

  it("Go sem main.go (biblioteca) é unknown", () => {
    const result = detect(tree({ "go.mod": "module x\n\ngo 1.22\n" }));
    expect(result.kind).toBe("unknown");
    expect(result.justification.join(" ")).toMatch(/só pacotes de biblioteca/);
  });

  it("repo sem nenhum arquivo de stack é unknown e pede Dockerfile", () => {
    const result = detect(tree({ "README.md": "" }));
    expect(result.kind).toBe("unknown");
    expect(result.justification.join(" ")).toMatch(/adicione um Dockerfile/);
  });
});
