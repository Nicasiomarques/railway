import { randomBytes } from "node:crypto";
import type { Keyring } from "./envelope.js";

// Keyring descartável para testes. Nunca use em dev ou produção.
export function testKeyring(): Keyring {
  return { currentKid: "test-1", keys: new Map([["test-1", randomBytes(32)]]) };
}
