import type { ObjectStorageProvider } from "./adapter.js";

// Simulates object storage with no external calls: a plain in-process Map. Tests only.
export class InMemoryObjectStorageProvider implements ObjectStorageProvider {
  private readonly objects = new Map<string, Buffer>();

  async put(key: string, data: Buffer | string): Promise<void> {
    this.objects.set(key, Buffer.isBuffer(data) ? data : Buffer.from(data));
  }

  async get(key: string): Promise<Buffer | null> {
    return this.objects.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }
}
