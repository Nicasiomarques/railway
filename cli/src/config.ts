import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type GlobalConfig = { apiUrl: string; token: string };

const GLOBAL_DIR = join(homedir(), ".railway-like");
const GLOBAL_CONFIG_PATH = join(GLOBAL_DIR, "config.json");

export const GLOBAL_CONFIG_FILE = GLOBAL_CONFIG_PATH;

export function loadGlobalConfig(): GlobalConfig | null {
  if (!existsSync(GLOBAL_CONFIG_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, "utf8"));
    if (typeof parsed.apiUrl !== "string" || typeof parsed.token !== "string") return null;
    return { apiUrl: parsed.apiUrl, token: parsed.token };
  } catch {
    return null;
  }
}

// Token guardado em texto puro, como o hash sha256 do lado da API só compara igualdade;
// por isso o arquivo precisa ficar com permissões restritas (600).
export function saveGlobalConfig(config: GlobalConfig): void {
  mkdirSync(GLOBAL_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(GLOBAL_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(GLOBAL_CONFIG_PATH, 0o600);
}

export type ProjectConfig = {
  // Sobrepõe a URL da API do config global, só se o projeto precisar de outro ambiente.
  apiUrl?: string;
  organizationId: string;
  organizationName?: string;
  projectId: string;
  projectName?: string;
  environmentId: string;
  environmentName?: string;
  serviceInstanceId: string;
  serviceName?: string;
};

const PROJECT_DIR_NAME = ".railway-like";
const PROJECT_CONFIG_FILE_NAME = "config.json";

export function projectConfigPathIn(dir: string): string {
  return join(dir, PROJECT_DIR_NAME, PROJECT_CONFIG_FILE_NAME);
}

export type FoundProjectConfig = { dir: string; path: string; config: ProjectConfig };

// Sobe diretórios a partir de `startDir` até achar `.railway-like/config.json`, como o `.git` do Git.
export function findProjectConfig(startDir: string = process.cwd()): FoundProjectConfig | null {
  let dir = resolve(startDir);
  while (true) {
    const path = projectConfigPathIn(dir);
    if (existsSync(path)) {
      try {
        const config = JSON.parse(readFileSync(path, "utf8")) as ProjectConfig;
        return { dir, path, config };
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function saveProjectConfig(dir: string, config: ProjectConfig): string {
  const fileDir = join(dir, PROJECT_DIR_NAME);
  mkdirSync(fileDir, { recursive: true });
  const path = projectConfigPathIn(dir);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}
