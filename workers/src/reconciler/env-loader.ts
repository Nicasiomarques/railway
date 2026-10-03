import { eq } from "drizzle-orm";
import { envSnapshots, openEnvSnapshot, type Db, type Keyring } from "@railway-like/db";
import type { LoadEnv } from "./postgres-store.js";
import { PermanentError } from "./errors.js";

// Abre o snapshot de env do deployment. Sem snapshot o deploy não tem como ser correto:
// o snapshot é gravado antes do deploy (architecture.md §5.2, passo 6), então a ausência é erro.
export function createEnvLoader(db: Db, keyring: Keyring): LoadEnv {
  return async (envSnapshotId) => {
    if (!envSnapshotId) throw new PermanentError("deployment sem snapshot de env: não é possível convergir");
    const [row] = await db
      .select({ payloadEnc: envSnapshots.payloadEnc })
      .from(envSnapshots)
      .where(eq(envSnapshots.id, envSnapshotId));
    if (!row) throw new PermanentError(`snapshot de env ${envSnapshotId} não encontrado`);
    try {
      return openEnvSnapshot(keyring, envSnapshotId, row.payloadEnc);
    } catch (err) {
      // Snapshot que não decifra ou não é JSON válido não melhora com retry.
      throw new PermanentError(`snapshot de env ${envSnapshotId} inválido: ${(err as Error).message}`);
    }
  };
}
