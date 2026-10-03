import { describe, expect, it } from "vitest";
import { InMemoryBuilder } from "./in-memory-builder.js";
import { handleCancelBuildJob } from "./cancel.js";

const REQ = { deploymentId: "d1", serviceInstanceId: "i1" };

describe("cancelamento de build", () => {
  it("cancelar marca o build como cancelado", async () => {
    const builder = new InMemoryBuilder();
    await builder.start({ ...REQ, repoUrl: "https://x/y.git", commitSha: "a".repeat(40), rootDir: "/" });

    await handleCancelBuildJob({ builder }, REQ);

    expect(await builder.status(REQ)).toEqual({ kind: "failed", reason: "build cancelado" });
  });

  it("sem builder configurado, o job é ignorado sem erro", async () => {
    expect(await handleCancelBuildJob({}, REQ)).toEqual({ kind: "skipped" });
  });
});
