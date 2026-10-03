// Real ObjectStorageProvider implementation backed by the local filesystem. Meant for local/dev
// and environments without real infra; a real S3/GCS implementation would live behind this same
// ObjectStorageProvider port later, swapped in without changing callers (see ./adapter.ts).

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { ObjectStorageProvider } from "./adapter.js";

const DEFAULT_BASE_DIR = "/tmp/railway-like-object-storage";

export class LocalFsObjectStorageProvider implements ObjectStorageProvider {
  private readonly baseDir: string;

  constructor(baseDir = process.env.OBJECT_STORAGE_DIR ?? DEFAULT_BASE_DIR) {
    this.baseDir = resolve(baseDir);
  }

  async put(key: string, data: Buffer | string): Promise<void> {
    const path = this.resolveKey(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }

  async get(key: string): Promise<Buffer | null> {
    const path = this.resolveKey(key);
    try {
      return await readFile(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.resolveKey(key);
    await rm(path, { force: true });
  }

  async exists(key: string): Promise<boolean> {
    const path = this.resolveKey(key);
    try {
      await stat(path);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  // Rejects keys that would escape the base directory (absolute paths, `..` segments that climb
  // out, etc.) before touching the filesystem.
  private resolveKey(key: string): string {
    if (!key || key.trim() === "") throw new Error(`invalid object storage key: ${JSON.stringify(key)}`);

    const resolved = resolve(this.baseDir, key);
    const withinBase = resolved === this.baseDir || resolved.startsWith(this.baseDir + sep);
    if (!withinBase) {
      throw new Error(`invalid object storage key (path traversal outside base dir): ${JSON.stringify(key)}`);
    }

    return join(resolved);
  }
}
