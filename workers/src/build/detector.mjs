// Detector de stack: função pura sobre a árvore de arquivos do repo (architecture.md §3).
// Escrito em JS puro e sem imports de pacote, porque o próprio arquivo é embutido no pod de build
// e executado com `node`, sem etapa de compilação. Também funciona como CLI (ver `main` no fim).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** @typedef {{ exists(path: string): boolean, read(path: string): string | null }} Tree */
/** @typedef {{ kind: "dockerfile" | "node" | "python" | "go" | "unknown", dockerfile: string | null, justification: string[] }} Detection */

const NODE_DEFAULT_MAJOR = "22";
const PYTHON_IMAGE = "python:3.12-slim";
const GO_DEFAULT_VERSION = "1.23";

/** @param {Tree} tree @returns {Detection} */
export function detect(tree) {
  if (tree.exists("Dockerfile")) {
    return { kind: "dockerfile", dockerfile: tree.read("Dockerfile"), justification: ["Dockerfile encontrado no repo: usado como está"] };
  }
  if (tree.exists("package.json")) return detectNode(tree);
  if (tree.exists("requirements.txt") || tree.exists("pyproject.toml")) return detectPython(tree);
  if (tree.exists("go.mod")) return detectGo(tree);
  return unknown(["nenhum arquivo de stack reconhecido (package.json, requirements.txt, pyproject.toml, go.mod)"]);
}

function unknown(justification) {
  return { kind: "unknown", dockerfile: null, justification: [...justification, "adicione um Dockerfile ao repo para controlar o build"] };
}

/** @param {Tree} tree */
function detectNode(tree) {
  const justification = ["package.json encontrado"];
  let pkg;
  try {
    pkg = JSON.parse(tree.read("package.json") ?? "");
  } catch {
    return unknown([...justification, "package.json não é JSON válido"]);
  }

  const range = pkg.engines?.node;
  const major = nodeMajor(range) ?? NODE_DEFAULT_MAJOR;
  justification.push(range ? `engines.node=${range} → node:${major}` : `sem engines.node → node:${major} (padrão)`);

  let install;
  let runner;
  if (tree.exists("pnpm-lock.yaml")) {
    install = "corepack enable && pnpm install --frozen-lockfile";
    runner = "pnpm";
    justification.push("pnpm-lock.yaml → pnpm (via corepack)");
  } else if (tree.exists("package-lock.json")) {
    install = "npm ci";
    runner = "npm";
    justification.push("package-lock.json → npm ci");
  } else {
    install = "npm install";
    runner = "npm";
    justification.push("sem lockfile → npm install (build não reprodutível)");
  }

  let start;
  if (pkg.scripts?.start) {
    start = [runner, "start"];
    justification.push(`scripts.start → ${runner} start`);
  } else {
    const main = pkg.main && tree.exists(pkg.main) ? pkg.main : ["index.js", "server.js"].find((f) => tree.exists(f));
    if (!main) return unknown([...justification, "sem scripts.start e sem entrypoint reconhecível (index.js, server.js ou main)"]);
    start = ["node", main];
    justification.push(`entrypoint → node ${main}`);
  }

  const dockerfile = [
    `FROM node:${major}-alpine`,
    "WORKDIR /app",
    "COPY . .",
    `RUN ${install}`,
    "ENV NODE_ENV=production",
    "USER 1000",
    "EXPOSE 8080",
    `CMD ${JSON.stringify(start)}`,
  ].join("\n") + "\n";
  return { kind: "node", dockerfile, justification };
}

/** Maior versão de Node aceita pelo range (">=20" → "20", "^18.12" → "18", "20.x" → "20"). */
function nodeMajor(range) {
  const m = typeof range === "string" ? /(\d+)/.exec(range) : null;
  return m ? m[1] : null;
}

/** @param {Tree} tree */
function detectPython(tree) {
  const justification = [tree.exists("requirements.txt") ? "requirements.txt encontrado" : "pyproject.toml encontrado"];
  const install = tree.exists("requirements.txt")
    ? "pip install --no-cache-dir -r requirements.txt"
    : "pip install --no-cache-dir .";
  justification.push(`instalação → ${install}`);

  const entry = ["main.py", "app.py", "server.py"].find((f) => tree.exists(f));
  if (!entry) return unknown([...justification, "nenhum entrypoint reconhecido (main.py, app.py, server.py)"]);
  justification.push(`entrypoint → python ${entry}`);

  const dockerfile = [
    `FROM ${PYTHON_IMAGE}`,
    "WORKDIR /app",
    "COPY . .",
    `RUN ${install}`,
    "ENV PYTHONUNBUFFERED=1",
    "USER 1000",
    "EXPOSE 8080",
    `CMD ${JSON.stringify(["python", entry])}`,
  ].join("\n") + "\n";
  return { kind: "python", dockerfile, justification };
}

/** @param {Tree} tree */
function detectGo(tree) {
  const goMod = tree.read("go.mod") ?? "";
  const version = /^go\s+(\d+\.\d+)/m.exec(goMod)?.[1] ?? GO_DEFAULT_VERSION;
  const justification = [`go.mod encontrado → go ${version}`];
  if (!tree.exists("main.go")) return unknown([...justification, "main.go não encontrado: só pacotes de biblioteca não viram imagem"]);

  const dockerfile = [
    `FROM golang:${version}-alpine AS build`,
    "WORKDIR /src",
    "COPY . .",
    "RUN CGO_ENABLED=0 go build -o /out/app .",
    "FROM alpine:3.20",
    "COPY --from=build /out/app /app",
    "USER 1000",
    "EXPOSE 8080",
    'CMD ["/app"]',
  ].join("\n") + "\n";
  return { kind: "go", dockerfile, justification };
}

// CLI: `node detector.mjs <srcDir> <rootDir> <outDir>`. Grava outDir/Dockerfile e outDir/detection.txt.
// Sai com código 2 quando a stack não é reconhecida, para o build falhar com a justificativa nos logs.
function main(argv) {
  const [srcDir, rootDir = "", outDir] = argv;
  const base = join(srcDir, rootDir);
  const tree = {
    exists: (p) => existsSync(join(base, p)),
    read: (p) => (existsSync(join(base, p)) ? readFileSync(join(base, p), "utf8") : null),
  };
  const result = detect(tree);
  const report = [`stack: ${result.kind}`, ...result.justification.map((j) => `- ${j}`)].join("\n") + "\n";
  process.stdout.write(report);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "detection.txt"), report);
  if (!result.dockerfile) process.exit(2);
  writeFileSync(join(outDir, "Dockerfile"), result.dockerfile);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
