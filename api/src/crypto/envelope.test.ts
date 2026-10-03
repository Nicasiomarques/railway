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
  it("decifra o que foi cifrado com o mesmo contexto", () => {
    const kr = keyring(["k1"], "k1");
    const payload = encryptValue(kr, "postgres://user:senha@host/db", ctx);
    expect(decryptValue(kr, payload, ctx)).toBe("postgres://user:senha@host/db");
  });

  it("não expõe o texto puro no payload", () => {
    const kr = keyring(["k1"], "k1");
    const payload = encryptValue(kr, "minha-senha-secreta", ctx);
    expect(payload).not.toContain("minha-senha-secreta");
    expect(payload).not.toContain(Buffer.from("minha-senha-secreta").toString("base64url"));
  });

  it("usa IV novo a cada cifragem", () => {
    const kr = keyring(["k1"], "k1");
    expect(encryptValue(kr, "x", ctx)).not.toBe(encryptValue(kr, "x", ctx));
  });

  it("falha se o contexto for diferente (valor copiado para outra variável)", () => {
    const kr = keyring(["k1"], "k1");
    const payload = encryptValue(kr, "segredo", ctx);
    expect(() => decryptValue(kr, payload, "variable:outra:DATABASE_URL")).toThrow(CryptoError);
  });

  it("detecta adulteração do ciphertext", () => {
    const kr = keyring(["k1"], "k1");
    const parts = encryptValue(kr, "segredo", ctx).split(".");
    const ct = Buffer.from(parts[6], "base64url");
    ct[0] ^= 0xff;
    parts[6] = ct.toString("base64url");
    expect(() => decryptValue(kr, parts.join("."), ctx)).toThrow(CryptoError);
  });

  it("falha com chave diferente sem revelar detalhes", () => {
    const payload = encryptValue(keyring(["k1"], "k1"), "segredo", ctx);
    const outra = { currentKid: "k1", keys: new Map([["k1", randomBytes(32)]]) };
    expect(() => decryptValue(outra, payload, ctx)).toThrow("Falha ao decifrar valor.");
  });

  it("decifra valores antigos depois da rotação, desde que a chave antiga esteja no keyring", () => {
    const antiga = keyring(["k1"], "k1");
    const payload = encryptValue(antiga, "segredo", ctx);

    const k1 = antiga.keys.get("k1")!;
    const rotacionado: Keyring = { currentKid: "k2", keys: new Map([["k1", k1], ["k2", randomBytes(32)]]) };

    expect(decryptValue(rotacionado, payload, ctx)).toBe("segredo");
    const novo = encryptValue(rotacionado, "segredo", ctx);
    expect(novo.split(".")[1]).toBe("k2");
  });

  it("falha quando o kid do payload não existe no keyring", () => {
    const payload = encryptValue(keyring(["k1"], "k1"), "segredo", ctx);
    expect(() => decryptValue(keyring(["k9"], "k9"), payload, ctx)).toThrow("Chave k1 não está disponível");
  });

  it("rejeita payload com formato inválido", () => {
    expect(() => decryptValue(keyring(["k1"], "k1"), "texto-puro", ctx)).toThrow("Formato");
  });
});

describe("loadKeyringFromEnv", () => {
  const key = randomBytes(32).toString("base64");

  it("carrega chaves e a chave atual", () => {
    const kr = loadKeyringFromEnv({ ENCRYPTION_KEYS: `k1:${key}`, ENCRYPTION_CURRENT_KID: "k1" } as NodeJS.ProcessEnv);
    expect(kr.currentKid).toBe("k1");
    expect(kr.keys.get("k1")!.length).toBe(32);
  });

  it("rejeita chave com tamanho errado", () => {
    expect(() =>
      loadKeyringFromEnv({ ENCRYPTION_KEYS: `k1:${randomBytes(16).toString("base64")}`, ENCRYPTION_CURRENT_KID: "k1" } as NodeJS.ProcessEnv),
    ).toThrow("32 bytes");
  });

  it("rejeita kid atual ausente", () => {
    expect(() =>
      loadKeyringFromEnv({ ENCRYPTION_KEYS: `k1:${key}`, ENCRYPTION_CURRENT_KID: "k2" } as NodeJS.ProcessEnv),
    ).toThrow("não existe");
  });

  it("rejeita ambiente sem configuração", () => {
    expect(() => loadKeyringFromEnv({} as NodeJS.ProcessEnv)).toThrow("obrigatórios");
  });
});
