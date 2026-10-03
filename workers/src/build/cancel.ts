import type { CancelBuildJobData } from "@railway-like/shared";
import type { Builder } from "./builder.js";

// Sem builder configurado (modo memória), não há build para apagar.
export async function handleCancelBuildJob(
  deps: { builder?: Builder },
  data: CancelBuildJobData,
): Promise<{ kind: "cancelled" } | { kind: "skipped" }> {
  if (!deps.builder) return { kind: "skipped" };
  await deps.builder.cancel(data);
  return { kind: "cancelled" };
}
