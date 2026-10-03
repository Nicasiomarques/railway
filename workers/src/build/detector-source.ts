import { readFileSync } from "node:fs";

// Código do detector, para embutir no pod de build. O arquivo fica ao lado deste módulo
// (em src/ durante os testes, em dist/ depois do build).
export function detectorSource(): string {
  return readFileSync(new URL("./detector.mjs", import.meta.url), "utf8");
}
