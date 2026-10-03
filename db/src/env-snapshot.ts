import { CryptoError, decryptValue, encryptValue, type Keyring } from "./crypto/envelope.js";

// Env snapshot: string → string JSON, encrypted. The snapshot id is the context (AAD),
// so a payload copied to another snapshot won't decrypt.
const snapshotContext = (snapshotId: string) => `env_snapshot:${snapshotId}`;

export function sealEnvSnapshot(keyring: Keyring, snapshotId: string, env: Record<string, string>): string {
  return encryptValue(keyring, JSON.stringify(env), snapshotContext(snapshotId));
}

export function openEnvSnapshot(keyring: Keyring, snapshotId: string, payload: string): Record<string, string> {
  const parsed: unknown = JSON.parse(decryptValue(keyring, payload, snapshotContext(snapshotId)));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CryptoError("Env snapshot is not an object.");
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") throw new CryptoError(`Snapshot value for ${key} is not a string.`);
  }
  return parsed as Record<string, string>;
}
