// Object storage port (roadmap.md Phase 4 and architecture.md §6): "Stateful (Postgres/Redis/
// volumes): PVC + scheduled backup (volume snapshot + logical dump) to object storage." Only the
// backup provider (workers/src/backup) calls this interface today. Implementations:
// InMemoryObjectStorageProvider (tests) and LocalFsObjectStorageProvider (local/dev, and
// environments without real infra). A real S3/GCS implementation comes later, behind this same
// port.

export interface ObjectStorageProvider {
  put(key: string, data: Buffer | string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}
