import { eq } from "drizzle-orm";
import { envSnapshots, openEnvSnapshot, type Db, type Keyring } from "@railway-like/db";
import type { LoadEnv } from "./postgres-store.js";
import { PermanentError } from "./errors.js";

// Opens the deployment's env snapshot. With no snapshot, the deploy can't possibly be correct:
// the snapshot is written before the deploy (architecture.md §5.2, step 6), so its absence is an error.
export function createEnvLoader(db: Db, keyring: Keyring): LoadEnv {
  return async (envSnapshotId) => {
    if (!envSnapshotId) throw new PermanentError("deployment has no env snapshot: cannot converge");
    const [row] = await db
      .select({ payloadEnc: envSnapshots.payloadEnc })
      .from(envSnapshots)
      .where(eq(envSnapshots.id, envSnapshotId));
    if (!row) throw new PermanentError(`env snapshot ${envSnapshotId} not found`);
    try {
      return openEnvSnapshot(keyring, envSnapshotId, row.payloadEnc);
    } catch (err) {
      // A snapshot that doesn't decrypt or isn't valid JSON won't improve with a retry.
      throw new PermanentError(`env snapshot ${envSnapshotId} is invalid: ${(err as Error).message}`);
    }
  };
}
