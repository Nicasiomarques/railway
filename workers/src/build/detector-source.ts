import { readFileSync } from "node:fs";

// Detector code, to embed in the build pod. The file sits next to this module
// (in src/ during tests, in dist/ after the build).
export function detectorSource(): string {
  return readFileSync(new URL("./detector.mjs", import.meta.url), "utf8");
}
