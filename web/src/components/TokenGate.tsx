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
      setError("Invalid token or API unavailable.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="gate">
      <form className="card" onSubmit={submit}>
        <h1>railway_like</h1>
        <p className="muted">Paste an API token. Generate one in dev with <code>pnpm db:seed</code> in <code>api/</code>.</p>
        <label>
          API token
          <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="rl_dev_..." autoFocus />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={!value.trim() || loading}>
          {loading ? "Verifying..." : "Sign in"}
        </button>
      </form>
    </div>
  );
}
