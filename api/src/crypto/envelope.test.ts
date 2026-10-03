import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CryptoError, decryptValue, encryptValue, loadKeyringFromEnv, type Keyring } from "./envelope.js";

const ctx = "variable:11111111-2222-3333-4444-555555555555:DATABASE_URL";

function keyring(kids: string[], current: string): Keyring {
  return {
    currentKid: current,
    keys: new Map(kids.map((kid) => [kid, randomBytes(32)])),
  };
}

describe("envelope", () => {
  it("decrypts what was encrypted with the same context", () => {
    const kr = keyring(["k1"], "k1");
    const payload = encryptValue(kr, "postgres://user:senha@host/db", ctx);
    expect(decryptValue(kr, payload, ctx)).toBe("postgres://user:senha@host/db");
  });

  it("does not expose the plain text in the payload", () => {
    const kr = keyring(["k1"], "k1");
    const payload = encryptValue(kr, "my-secret-password", ctx);
    expect(payload).not.toContain("my-secret-password");
    expect(payload).not.toContain(Buffer.from("my-secret-password").toString("base64url"));
  });

  it("uses a fresh IV on every encryption", () => {
    const kr = keyring(["k1"], "k1");
    expect(encryptValue(kr, "x", ctx)).not.toBe(encryptValue(kr, "x", ctx));
  });

  it("fails if the context is different (value copied to another variable)", () => {
    const kr = keyring(["k1"], "k1");
    const payload = encryptValue(kr, "secret", ctx);
    expect(() => decryptValue(kr, payload, "variable:another:DATABASE_URL")).toThrow(CryptoError);
  });

  it("detects ciphertext tampering", () => {
    const kr = keyring(["k1"], "k1");
    const parts = encryptValue(kr, "secret", ctx).split(".");
    const ct = Buffer.from(parts[6], "base64url");
    ct[0] ^= 0xff;
    parts[6] = ct.toString("base64url");
    expect(() => decryptValue(kr, parts.join("."), ctx)).toThrow(CryptoError);
  });

  it("fails with a different key without revealing details", () => {
    const payload = encryptValue(keyring(["k1"], "k1"), "secret", ctx);
    const another = { currentKid: "k1", keys: new Map([["k1", randomBytes(32)]]) };
    expect(() => decryptValue(another, payload, ctx)).toThrow("Falha ao decifrar valor.");
  });

  it("decrypts old values after rotation, as long as the old key is still in the keyring", () => {
    const old = keyring(["k1"], "k1");
    const payload = encryptValue(old, "secret", ctx);

    const k1 = old.keys.get("k1")!;
    const rotated: Keyring = { currentKid: "k2", keys: new Map([["k1", k1], ["k2", randomBytes(32)]]) };

    expect(decryptValue(rotated, payload, ctx)).toBe("secret");
    const fresh = encryptValue(rotated, "secret", ctx);
    expect(fresh.split(".")[1]).toBe("k2");
  });

  it("fails when the payload's kid does not exist in the keyring", () => {
    const payload = encryptValue(keyring(["k1"], "k1"), "secret", ctx);
    expect(() => decryptValue(keyring(["k9"], "k9"), payload, ctx)).toThrow("Chave k1 não está disponível");
  });

  it("rejects a payload with an invalid format", () => {
    expect(() => decryptValue(keyring(["k1"], "k1"), "plain-text", ctx)).toThrow("Formato");
  });
});

describe("loadKeyringFromEnv", () => {
  const key = randomBytes(32).toString("base64");

  it("loads the keys and the current key", () => {
    const kr = loadKeyringFromEnv({ ENCRYPTION_KEYS: `k1:${key}`, ENCRYPTION_CURRENT_KID: "k1" } as NodeJS.ProcessEnv);
    expect(kr.currentKid).toBe("k1");
    expect(kr.keys.get("k1")!.length).toBe(32);
  });

  it("rejects a key with the wrong size", () => {
    expect(() =>
      loadKeyringFromEnv({ ENCRYPTION_KEYS: `k1:${randomBytes(16).toString("base64")}`, ENCRYPTION_CURRENT_KID: "k1" } as NodeJS.ProcessEnv),
    ).toThrow("32 bytes");
  });

  it("rejects a missing current kid", () => {
    expect(() =>
      loadKeyringFromEnv({ ENCRYPTION_KEYS: `k1:${key}`, ENCRYPTION_CURRENT_KID: "k2" } as NodeJS.ProcessEnv),
    ).toThrow("não existe");
  });

  it("rejects an environment with no configuration", () => {
    expect(() => loadKeyringFromEnv({} as NodeJS.ProcessEnv)).toThrow("obrigatórios");
  });
});
