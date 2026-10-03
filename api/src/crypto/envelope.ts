// A cifragem de envelope vive no pacote @railway-like/db, compartilhado com os workers.
export { CryptoError, decryptValue, encryptValue, loadKeyringFromEnv, openEnvSnapshot, sealEnvSnapshot } from "@railway-like/db";
export type { Keyring } from "@railway-like/db";
