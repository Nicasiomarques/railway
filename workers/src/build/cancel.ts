import type { CancelBuildJobData } from "@railway-like/shared";
import type { Builder } from "./builder.js";

// Without a configured builder (in-memory mode), there's no build to delete.
export async function handleCancelBuildJob(
  deps: { builder?: Builder },
  data: CancelBuildJobData,
): Promise<{ kind: "cancelled" } | { kind: "skipped" }> {
  if (!deps.builder) return { kind: "skipped" };
  await deps.builder.cancel(data);
  return { kind: "cancelled" };
}
