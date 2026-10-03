import { describe, expect, it } from "vitest";
import { InMemoryBuilder } from "./in-memory-builder.js";
import { handleCancelBuildJob } from "./cancel.js";

const REQ = { deploymentId: "d1", serviceInstanceId: "i1" };

describe("build cancellation", () => {
  it("cancelling marks the build as cancelled", async () => {
    const builder = new InMemoryBuilder();
    await builder.start({ ...REQ, repoUrl: "https://x/y.git", commitSha: "a".repeat(40), rootDir: "/" });

    await handleCancelBuildJob({ builder }, REQ);

    expect(await builder.status(REQ)).toEqual({ kind: "failed", reason: "build cancelled" });
  });

  it("with no builder configured, the job is skipped without error", async () => {
    expect(await handleCancelBuildJob({}, REQ)).toEqual({ kind: "skipped" });
  });
});
