// Stack detector: pure function over the repo's file tree (architecture.md §3).
// Written in plain JS with no package imports, because this file itself is embedded in the build pod
// and run with `node`, with no compile step. Also works as a CLI (see `main` at the end).
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
    return { kind: "dockerfile", dockerfile: tree.read("Dockerfile"), justification: ["Dockerfile found in the repo: used as-is"] };
  }
  if (tree.exists("package.json")) return detectNode(tree);
  if (tree.exists("requirements.txt") || tree.exists("pyproject.toml")) return detectPython(tree);
  if (tree.exists("go.mod")) return detectGo(tree);
  return unknown(["no recognized stack file (package.json, requirements.txt, pyproject.toml, go.mod)"]);
}

function unknown(justification) {
  return { kind: "unknown", dockerfile: null, justification: [...justification, "add a Dockerfile to the repo to control the build"] };
}

/** @param {Tree} tree */
function detectNode(tree) {
  const justification = ["package.json found"];
  let pkg;
  try {
    pkg = JSON.parse(tree.read("package.json") ?? "");
  } catch {
    return unknown([...justification, "package.json is not valid JSON"]);
  }

  const range = pkg.engines?.node;
  const major = nodeMajor(range) ?? NODE_DEFAULT_MAJOR;
  justification.push(range ? `engines.node=${range} → node:${major}` : `no engines.node → node:${major} (default)`);

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
    justification.push("no lockfile → npm install (non-reproducible build)");
  }

  let start;
  if (pkg.scripts?.start) {
    start = [runner, "start"];
    justification.push(`scripts.start → ${runner} start`);
  } else {
    const main = pkg.main && tree.exists(pkg.main) ? pkg.main : ["index.js", "server.js"].find((f) => tree.exists(f));
    if (!main) return unknown([...justification, "no scripts.start and no recognizable entrypoint (index.js, server.js or main)"]);
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

/** Highest Node version accepted by the range (">=20" → "20", "^18.12" → "18", "20.x" → "20"). */
function nodeMajor(range) {
  const m = typeof range === "string" ? /(\d+)/.exec(range) : null;
  return m ? m[1] : null;
}

/** @param {Tree} tree */
function detectPython(tree) {
  const justification = [tree.exists("requirements.txt") ? "requirements.txt found" : "pyproject.toml found"];
  const install = tree.exists("requirements.txt")
    ? "pip install --no-cache-dir -r requirements.txt"
    : "pip install --no-cache-dir .";
  justification.push(`install → ${install}`);

  const entry = ["main.py", "app.py", "server.py"].find((f) => tree.exists(f));
  if (!entry) return unknown([...justification, "no recognized entrypoint (main.py, app.py, server.py)"]);
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
  const justification = [`go.mod found → go ${version}`];
  if (!tree.exists("main.go")) return unknown([...justification, "main.go not found: library-only packages don't become an image"]);

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

// CLI: `node detector.mjs <srcDir> <rootDir> <outDir>`. Writes outDir/Dockerfile and outDir/detection.txt.
// Exits with code 2 when the stack isn't recognized, so the build fails with the justification in the logs.
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
