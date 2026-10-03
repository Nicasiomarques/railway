import { describe, expect, it } from "vitest";
import { InMemoryObjectStorageProvider } from "./in-memory.js";

describe("InMemoryObjectStorageProvider", () => {
  it("exists is false and get is null for a key that was never put", async () => {
    const storage = new InMemoryObjectStorageProvider();
    expect(await storage.exists("missing")).toBe(false);
    expect(await storage.get("missing")).toBeNull();
  });

  it("put then get returns the same bytes, for a string payload", async () => {
    const storage = new InMemoryObjectStorageProvider();
    await storage.put("key-1", "hello world");
    const data = await storage.get("key-1");
    expect(data).not.toBeNull();
    expect(data?.toString("utf8")).toBe("hello world");
  });

  it("put then get returns the same bytes, for a Buffer payload", async () => {
    const storage = new InMemoryObjectStorageProvider();
    await storage.put("key-2", Buffer.from([1, 2, 3]));
    const data = await storage.get("key-2");
    expect(data).toEqual(Buffer.from([1, 2, 3]));
  });

  it("exists is true after put", async () => {
    const storage = new InMemoryObjectStorageProvider();
    await storage.put("key-3", "x");
    expect(await storage.exists("key-3")).toBe(true);
  });

  it("delete removes the key", async () => {
    const storage = new InMemoryObjectStorageProvider();
    await storage.put("key-4", "x");
    await storage.delete("key-4");
    expect(await storage.exists("key-4")).toBe(false);
    expect(await storage.get("key-4")).toBeNull();
  });

  it("delete on a missing key is a no-op", async () => {
    const storage = new InMemoryObjectStorageProvider();
    await expect(storage.delete("never-existed")).resolves.toBeUndefined();
  });

  it("put overwrites a previous value for the same key", async () => {
    const storage = new InMemoryObjectStorageProvider();
    await storage.put("key-5", "first");
    await storage.put("key-5", "second");
    expect((await storage.get("key-5"))?.toString("utf8")).toBe("second");
  });
});
