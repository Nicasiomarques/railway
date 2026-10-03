import { useState } from "react";
import { api, tokenStore } from "../api";

export function TokenGate({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    tokenStore.set(value.trim());
    try {
      await api("/organizations");
      onAuthenticated();
    } catch {
      tokenStore.clear();
      setError("Token inválido ou API indisponível.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="gate">
      <form className="card" onSubmit={submit}>
        <h1>railway_like</h1>
        <p className="muted">Cole um token de API. Gere um em dev com <code>pnpm db:seed</code> em <code>api/</code>.</p>
        <label>
          Token de API
          <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="rl_dev_..." autoFocus />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={!value.trim() || loading}>
          {loading ? "Verificando..." : "Entrar"}
        </button>
      </form>
    </div>
  );
}
