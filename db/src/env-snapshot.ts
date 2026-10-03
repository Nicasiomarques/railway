import { CryptoError, decryptValue, encryptValue, type Keyring } from "./crypto/envelope.js";

// Snapshot de env: JSON de string → string, cifrado. O id do snapshot é o contexto (AAD),
// então um payload copiado para outro snapshot não decifra.
const snapshotContext = (snapshotId: string) => `env_snapshot:${snapshotId}`;

export function sealEnvSnapshot(keyring: Keyring, snapshotId: string, env: Record<string, string>): string {
  return encryptValue(keyring, JSON.stringify(env), snapshotContext(snapshotId));
}

export function openEnvSnapshot(keyring: Keyring, snapshotId: string, payload: string): Record<string, string> {
  const parsed: unknown = JSON.parse(decryptValue(keyring, payload, snapshotContext(snapshotId)));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CryptoError("Snapshot de env não é um objeto.");
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") throw new CryptoError(`Valor do snapshot para ${key} não é texto.`);
  }
  return parsed as Record<string, string>;
}
