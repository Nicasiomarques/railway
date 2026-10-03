import { randomBytes } from "node:crypto";
import type { Keyring } from "./envelope.js";

// Disposable keyring for tests. Never use in dev or production.
export function testKeyring(): Keyring {
  return { currentKid: "test-1", keys: new Map([["test-1", randomBytes(32)]]) };
}
