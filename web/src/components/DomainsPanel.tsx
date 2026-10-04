import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiProblem, type Domain } from "../api";

// Same hostname rule enforced by the API (api/src/routes/domains.ts).
const HOSTNAME_PATTERN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export function DomainsPanel({ instanceId, canWrite }: { instanceId: string; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<{ type: "auto" | "custom"; hostname: string }>({ type: "auto", hostname: "" });
  const [error, setError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["domains", instanceId],
    queryFn: () => api<{ data: Domain[] }>(`/services/${instanceId}/domains`).then((r) => r.data),
  });

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(`/services/${instanceId}/domains`, {
        method: "POST",
        json:
          form.type === "custom"
            ? { type: "custom", hostname: form.hostname.trim().toLowerCase() }
            : { type: "auto" },
      });
      setForm({ type: "auto", hostname: "" });
      setAdding(false);
      queryClient.invalidateQueries({ queryKey: ["domains", instanceId] });
    } catch (err) {
      setError(err instanceof ApiProblem ? err.message : "Error creating domain.");
    }
  }

  async function remove(domain: Domain) {
    if (!window.confirm(`Remove domain ${domain.hostname}?`)) return;
    setError(null);
    try {
      await api(`/services/${instanceId}/domains/${domain.id}`, { method: "DELETE" });
      queryClient.invalidateQueries({ queryKey: ["domains", instanceId] });
    } catch (err) {
      setError(err instanceof ApiProblem ? err.message : "Error removing domain.");
    }
  }

  const hostnameValid = HOSTNAME_PATTERN.test(form.hostname.trim().toLowerCase());
  const canSubmit = form.type === "auto" || hostnameValid;

  return (
    <section className="domains">
      <div className="section-head">
        <h3>Domains</h3>
      </div>

      {error && <p className="error">{error}</p>}

      {list.isLoading && (
        <ul className="list">
          <li className="skeleton" style={{ height: 38 }} />
          <li className="skeleton" style={{ height: 38 }} />
        </ul>
      )}
      <ul className="list">
        {list.data?.map((d) => (
          <li key={d.id} className="card-row">
            <div>
              <strong>{d.hostname}</strong>{" "}
              <span className="chip">{d.type}</span>{" "}
              <span className={`status status-${d.tlsState}`}>{d.tlsState}</span>
            </div>
            {canWrite && (
              <div className="var-actions">
                <button className="ghost small" onClick={() => remove(d)}>
                  Remove
                </button>
              </div>
            )}
          </li>
        ))}
        {list.data?.length === 0 && <li className="muted">No domains yet.</li>}
      </ul>

      {canWrite && (
        <div className="disclose">
          {!adding ? (
            <button className="disclose-trigger" onClick={() => setAdding(true)}>
              + Add domain
            </button>
          ) : (
            <form className="disclose-body inline wrap" onSubmit={create}>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as "auto" | "custom" })}>
                <option value="auto">auto</option>
                <option value="custom">custom</option>
              </select>
              {form.type === "custom" && (
                <input
                  value={form.hostname}
                  onChange={(e) => setForm({ ...form, hostname: e.target.value })}
                  placeholder="app.example.com"
                  aria-label="hostname"
                  autoFocus
                />
              )}
              <button type="submit" disabled={!canSubmit}>
                Add domain
              </button>
              <button type="button" className="ghost" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </form>
          )}
        </div>
      )}
    </section>
  );
}
