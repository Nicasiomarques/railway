import { GLOBAL_CONFIG_FILE, loadGlobalConfig, saveGlobalConfig } from "../config.js";
import { apiRequest } from "../http.js";
import { ask } from "../prompt.js";
import type { ListOf, Organization } from "../types.js";

export async function loginCommand(): Promise<void> {
  const existing = loadGlobalConfig();
  const apiUrl = (await ask("URL da API", existing?.apiUrl ?? "http://localhost:3000")).replace(/\/+$/, "");
  const token = await ask("Token de API", existing?.token);
  if (!apiUrl || !token) {
    throw new Error("URL da API e token são obrigatórios.");
  }

  // Valida o token com uma chamada simples, como o TokenGate faz no front-end (ver web/src/components/TokenGate.tsx).
  await apiRequest<ListOf<Organization>>({ apiUrl, token }, "GET", "/organizations");

  saveGlobalConfig({ apiUrl, token });
  console.log(`Login salvo em ${GLOBAL_CONFIG_FILE}.`);
}
