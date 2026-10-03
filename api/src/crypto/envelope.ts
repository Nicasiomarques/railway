import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Envelope: cada valor é cifrado com uma DEK aleatória; a DEK é cifrada ("embrulhada")
// por uma KEK identificada por `kid`. Rotacionar = adicionar nova KEK e manter as antigas
// no keyring até os valores serem re-embrulhados.
//
// Formato: v1.<kid>.<wrapIv>.<wrappedDek>.<wrapTag>.<iv>.<ciphertext>.<tag>
// Todos os segmentos em base64url. `context` é autenticado (AAD): um valor cifrado
// para uma variável não decifra em outra.

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const VERSION = "v1";

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoError";
  }
}

export type Keyring = {
  currentKid: string;
  keys: ReadonlyMap<string, Buffer>;
};

// ENCRYPTION_KEYS="kid1:<base64>,kid2:<base64>"  ENCRYPTION_CURRENT_KID=kid2
export function loadKeyringFromEnv(env: NodeJS.ProcessEnv = process.env): Keyring {
  const raw = env.ENCRYPTION_KEYS;
  const currentKid = env.ENCRYPTION_CURRENT_KID;
  if (!raw || !currentKid) {
    throw new CryptoError("ENCRYPTION_KEYS e ENCRYPTION_CURRENT_KID são obrigatórios.");
  }

  const keys = new Map<string, Buffer>();
  for (const entry of raw.split(",")) {
    const [kid, b64] = entry.split(":");
    if (!kid || !b64) throw new CryptoError("ENCRYPTION_KEYS mal formado.");
    const key = Buffer.from(b64, "base64");
    if (key.length !== KEY_BYTES) throw new CryptoError(`Chave ${kid} deve ter ${KEY_BYTES} bytes.`);
    keys.set(kid, key);
  }

  if (!keys.has(currentKid)) {
    throw new CryptoError("ENCRYPTION_CURRENT_KID não existe em ENCRYPTION_KEYS.");
  }
  return { currentKid, keys };
}

type Sealed = { iv: Buffer; ciphertext: Buffer; tag: Buffer };

function seal(key: Buffer, plaintext: Buffer, aad: Buffer): Sealed {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, ciphertext, tag: cipher.getAuthTag() };
}

function open(key: Buffer, sealed: Sealed, aad: Buffer): Buffer {
  const decipher = createDecipheriv(ALGORITHM, key, sealed.iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.tag);
  try {
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
  } catch {
    // Mensagem genérica: não dizer se foi chave errada, contexto errado ou dado adulterado.
    throw new CryptoError("Falha ao decifrar valor.");
  }
}

const b64 = (buf: Buffer) => buf.toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url");

function dekAad(kid: string, context: string): Buffer {
  return Buffer.from(`dek:${kid}:${context}`);
}

export function encryptValue(keyring: Keyring, plaintext: string, context: string): string {
  const kek = keyring.keys.get(keyring.currentKid)!;
  const dek = randomBytes(KEY_BYTES);
  try {
    const value = seal(dek, Buffer.from(plaintext, "utf8"), Buffer.from(context));
    const wrapped = seal(kek, dek, dekAad(keyring.currentKid, context));
    return [
      VERSION,
      keyring.currentKid,
      b64(wrapped.iv),
      b64(wrapped.ciphertext),
      b64(wrapped.tag),
      b64(value.iv),
      b64(value.ciphertext),
      b64(value.tag),
    ].join(".");
  } finally {
    dek.fill(0);
  }
}

export function decryptValue(keyring: Keyring, payload: string, context: string): string {
  const parts = payload.split(".");
  if (parts.length !== 8 || parts[0] !== VERSION) {
    throw new CryptoError("Formato de payload cifrado inválido.");
  }
  const [, kid, wIv, wCt, wTag, iv, ct, tag] = parts;

  const kek = keyring.keys.get(kid);
  if (!kek) throw new CryptoError(`Chave ${kid} não está disponível no keyring.`);

  const dek = open(
    kek,
    { iv: unb64(wIv), ciphertext: unb64(wCt), tag: unb64(wTag) },
    dekAad(kid, context),
  );
  try {
    const value = open(dek, { iv: unb64(iv), ciphertext: unb64(ct), tag: unb64(tag) }, Buffer.from(context));
    return value.toString("utf8");
  } finally {
    dek.fill(0);
  }
}
