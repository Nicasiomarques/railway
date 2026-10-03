import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiProblem, type Variable } from "../api";

// Same key rule enforced by the API (api/src/routes/variables.ts).
const KEY_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;

export function VariablesPanel({ instanceId, canWrite }: { instanceId: string; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ key: "", value: "", isSecret: false });
  const [error, setError] = useState<string | null>(null);
  // Keys whose "reveal" was explicitly requested; never populated by default.
  const [revealed, setRevealed] = useState<Set<string>>(new Set());

  const list = useQuery({
    queryKey: ["variables", instanceId],
    queryFn: () => api<{ data: Variable[] }>(`/services/${instanceId}/variables`).then((r) => r.data),
  });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const key = form.key.trim();
      // PUT upserts by key: the same form handles both create and update.
      await api(`/services/${instanceId}/variables/${key}`, {
        method: "PUT",
        json: { value: form.value, isSecret: form.isSecret },
      });
      setForm({ key: "", value: "", isSecret: false });
      queryClient.invalidateQueries({ queryKey: ["variables", instanceId] });
    } catch (err) {
      setError(err instanceof ApiProblem ? err.message : "Error saving variable.");
    }
  }

  async function remove(key: string) {
    if (!window.confirm(`Remove variable ${key}?`)) return;
    setError(null);
    try {
      await api(`/services/${instanceId}/variables/${key}`, { method: "DELETE" });
      setRevealed((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      queryClient.invalidateQueries({ queryKey: ["variables", instanceId] });
    } catch (err) {
      setError(err instanceof ApiProblem ? err.message : "Error removing variable.");
    }
  }

  function toggleReveal(key: string) {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Fills the form with the selected variable; secrets come without a value (the API never returns it).
  function edit(v: Variable) {
    setForm({ key: v.key, value: v.value ?? "", isSecret: v.isSecret });
  }

  const keyValid = KEY_PATTERN.test(form.key.trim());

  return (
    <section className="variables">
      <div className="section-head">
        <h3>Variables</h3>
      </div>

      {canWrite && (
        <form className="inline wrap" onSubmit={save}>
          <input
            value={form.key}
            onChange={(e) => setForm({ ...form, key: e.target.value.toUpperCase() })}
            placeholder="VARIABLE_NAME"
            aria-label="key"
          />
          <input
            value={form.value}
            onChange={(e) => setForm({ ...form, value: e.target.value })}
            placeholder="value"
            aria-label="value"
          />
          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.isSecret}
              onChange={(e) => setForm({ ...form, isSecret: e.target.checked })}
            />
            secret
          </label>
          <button type="submit" disabled={!keyValid}>
            Save
          </button>
        </form>
      )}
      {error && <p className="error">{error}</p>}

      <ul className="list">
        {list.data?.map((v) => (
          <li key={v.key} className="card-row">
            <div>
              <strong>{v.key}</strong>{" "}
              {/* This route only lists the instance's own variables; the API doesn't yet
                  resolve/expose environment or project inheritance for this origin. */}
              <span className="pill">own instance</span>
              {v.isSecret && <span className="chip">secret</span>}
            </div>
            <div className="var-actions">
              <code>
                {v.isSecret
                  ? revealed.has(v.key)
                    ? "the API never returns a secret's value — save a new value to replace it"
                    : "••••••"
                  : v.value}
              </code>
              {v.isSecret && (
                <button className="ghost small" onClick={() => toggleReveal(v.key)}>
                  {revealed.has(v.key) ? "Hide" : "Reveal"}
                </button>
              )}
              {canWrite && (
                <>
                  <button className="ghost small" onClick={() => edit(v)}>
                    Edit
                  </button>
                  <button className="ghost small" onClick={() => remove(v.key)}>
                    Remove
                  </button>
                </>
              )}
            </div>
          </li>
        ))}
        {list.data?.length === 0 && <li className="muted">No variables yet.</li>}
      </ul>
    </section>
  );
}
