import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsObjectStorageProvider } from "./local-fs.js";

describe("LocalFsObjectStorageProvider", () => {
  let baseDir: string;
  let storage: LocalFsObjectStorageProvider;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "railway-like-object-storage-test-"));
    storage = new LocalFsObjectStorageProvider(baseDir);
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("exists is false and get is null for a key that was never put", async () => {
    expect(await storage.exists("missing")).toBe(false);
    expect(await storage.get("missing")).toBeNull();
  });

  it("put then get returns the same bytes, for a string payload", async () => {
    await storage.put("key-1", "hello world");
    const data = await storage.get("key-1");
    expect(data?.toString("utf8")).toBe("hello world");
  });

  it("put then get returns the same bytes, for a Buffer payload", async () => {
    await storage.put("key-2", Buffer.from([1, 2, 3]));
    expect(await storage.get("key-2")).toEqual(Buffer.from([1, 2, 3]));
  });

  it("put creates nested directories for a nested key", async () => {
    await storage.put("backups/vol-1/dump.json", "{}");
    const onDisk = await readFile(join(baseDir, "backups", "vol-1", "dump.json"), "utf8");
    expect(onDisk).toBe("{}");
  });

  it("exists is true after put, and delete removes it", async () => {
    await storage.put("key-3", "x");
    expect(await storage.exists("key-3")).toBe(true);

    await storage.delete("key-3");
    expect(await storage.exists("key-3")).toBe(false);
    expect(await storage.get("key-3")).toBeNull();
  });

  it("delete on a missing key is a no-op", async () => {
    await expect(storage.delete("never-existed")).resolves.toBeUndefined();
  });

  it("writes stay within the base directory given a different provider instance", async () => {
    await storage.put("isolated", "a");
    const other = await mkdtemp(join(tmpdir(), "railway-like-object-storage-test-other-"));
    try {
      const otherStorage = new LocalFsObjectStorageProvider(other);
      expect(await otherStorage.exists("isolated")).toBe(false);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("rejects a key that escapes the base directory with '..'", async () => {
    await expect(storage.put("../escape.txt", "x")).rejects.toThrow(/traversal/);
  });

  it("rejects a key that escapes the base directory with a nested '..'", async () => {
    await expect(storage.put("sub/../../escape.txt", "x")).rejects.toThrow(/traversal/);
  });

  it("rejects an absolute path key", async () => {
    await expect(storage.put("/etc/passwd", "x")).rejects.toThrow(/traversal/);
  });

  it("rejects an empty key", async () => {
    await expect(storage.put("", "x")).rejects.toThrow();
  });

  it("get and exists also reject a path-traversal key, instead of reading outside the base dir", async () => {
    await expect(storage.get("../escape.txt")).rejects.toThrow(/traversal/);
    await expect(storage.exists("../escape.txt")).rejects.toThrow(/traversal/);
  });
});
