// Templates (architecture.md Phase 4 "Cron jobs, workers, object storage"): service sources whose
// image is resolved automatically instead of being supplied by the caller, the same way
// `github_repo` resolves to an image through the build pipeline instead of a caller-provided digest.
//
// Digests are pinned, not resolved live against a registry: resolving a tag to a digest on every
// deployment would add a network call (and a new failure mode) to the deployment-creation path.
// Update a pinned digest deliberately when the upstream image changes, the same way a lockfile
// is bumped, e.g. by querying the registry's v2 manifest API for the tag and copying the
// `docker-content-digest` response header.
export const TEMPLATE_SOURCES = ["postgres_template", "redis_template", "minio_template"] as const;
export type TemplateSource = (typeof TEMPLATE_SOURCES)[number];

export function isTemplateSource(source: string): source is TemplateSource {
  return (TEMPLATE_SOURCES as readonly string[]).includes(source);
}

const PINNED_TEMPLATE_IMAGES: Partial<Record<TemplateSource, string>> = {
  // postgres:16-alpine
  postgres_template: "docker.io/library/postgres@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea",
  // redis:7-alpine
  redis_template: "docker.io/library/redis@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499",
  // minio_template has no pinned digest: Docker Hub would not issue a pull token for minio/minio
  // from this environment at the time this was written, so it's left unpinned rather than guessed.
  // Set MINIO_TEMPLATE_IMAGE_DIGEST (full `registry/repo@sha256:...` reference) to enable it, or
  // pass imageDigest explicitly on each deployment until it's pinned here.
};

/** The pinned image for a template source, or null when it isn't configured yet. */
export function resolveTemplateImage(source: string): string | null {
  if (source === "minio_template" && process.env.MINIO_TEMPLATE_IMAGE_DIGEST) {
    return process.env.MINIO_TEMPLATE_IMAGE_DIGEST;
  }
  if (!isTemplateSource(source)) return null;
  return PINNED_TEMPLATE_IMAGES[source] ?? null;
}
