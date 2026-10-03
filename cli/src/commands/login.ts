import { GLOBAL_CONFIG_FILE, loadGlobalConfig, saveGlobalConfig } from "../config.js";
import { apiRequest } from "../http.js";
import { ask } from "../prompt.js";
import type { ListOf, Organization } from "../types.js";

export async function loginCommand(): Promise<void> {
  const existing = loadGlobalConfig();
  const apiUrl = (await ask("API URL", existing?.apiUrl ?? "http://localhost:3000")).replace(/\/+$/, "");
  const token = await ask("API token", existing?.token);
  if (!apiUrl || !token) {
    throw new Error("API URL and token are required.");
  }

  // Validates the token with a simple call, the same way TokenGate does on the front-end (see web/src/components/TokenGate.tsx).
  await apiRequest<ListOf<Organization>>({ apiUrl, token }, "GET", "/organizations");

  saveGlobalConfig({ apiUrl, token });
  console.log(`Login saved to ${GLOBAL_CONFIG_FILE}.`);
}
