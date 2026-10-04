import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiProblem, type Variable } from "../api";

// Same key rule enforced by the API (api/src/routes/variables.ts).
const KEY_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;

export function VariablesPanel({ instanceId, canWrite }: { instanceId: string; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [newVar, setNewVar] = useState({ key: "", value: "", isSecret: false });
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  // Keys whose "reveal" was explicitly requested; never populated by default.
  const [revealed, setRevealed] = useState<Set<string>>(new Set());

  const list = useQuery({
    queryKey: ["variables", instanceId],
    queryFn: () => api<{ data: Variable[] }>(`/services/${instanceId}/variables`).then((r) => r.data),
  });

  async function saveValue(key: string, value: string, isSecret: boolean) {
    setError(null);
    setSavingKey(key);
    try {
      // PUT upserts by key: the same call handles both create and update.
      await api(`/services/${instanceId}/variables/${key}`, {
        method: "PUT",
        json: { value, isSecret },
      });
      queryClient.invalidateQueries({ queryKey: ["variables", instanceId] });
      return true;
    } catch (err) {
      setError(err instanceof ApiProblem ? err.message : "Error saving variable.");
      return false;
    } finally {
      setSavingKey(null);
    }
  }

  async function createVariable(e: React.FormEvent) {
    e.preventDefault();
    const key = newVar.key.trim();
    const ok = await saveValue(key, newVar.value, newVar.isSecret);
    if (ok) {
      setNewVar({ key: "", value: "", isSecret: false });
      setAdding(false);
    }
  }

  async function submitEdit(key: string, isSecret: boolean) {
    const ok = await saveValue(key, editValue, isSecret);
    if (ok) setEditingKey(null);
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

  // Click-to-edit: starts inline editing for the clicked variable. Secrets start blank (the API
  // never returns a secret's value), so editing one always sets a fresh value.
  function startEdit(v: Variable) {
    setEditingKey(v.key);
    setEditValue(v.isSecret ? "" : v.value ?? "");
  }

  const newKeyValid = KEY_PATTERN.test(newVar.key.trim());

  return (
    <section className="variables">
      <div className="section-head">
        <h3>Variables</h3>
        {savingKey && (
          <span className="saving-indicator">
            <span className="spinner" /> Saving…
          </span>
        )}
      </div>
      {error && <p className="error">{error}</p>}

      {list.isLoading && (
        <ul className="list">
          <li className="skeleton" style={{ height: 38 }} />
          <li className="skeleton" style={{ height: 38 }} />
          <li className="skeleton" style={{ height: 38 }} />
        </ul>
      )}
      <ul className="list">
        {list.data?.map((v) => {
          const isEditing = editingKey === v.key;
          return (
            <li key={v.key} className="card-row var-row">
              {isEditing ? (
                <form
                  className="var-edit-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitEdit(v.key, v.isSecret);
                  }}
                >
                  <span className="var-key">{v.key}</span>
                  <input
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    placeholder={v.isSecret ? "new secret value" : "value"}
                    autoFocus
                  />
                  <button type="submit" className="small" disabled={savingKey === v.key}>
                    {savingKey === v.key ? "Saving…" : "Save"}
                  </button>
                  <button type="button" className="ghost small" onClick={() => setEditingKey(null)}>
                    Cancel
                  </button>
                </form>
              ) : (
                <>
                  <div className="var-key">
                    {v.key}
                    {v.isSecret && <span className="chip">secret</span>}
                  </div>
                  <div className="var-value">
                    <code onClick={() => canWrite && startEdit(v)} style={canWrite ? { cursor: "pointer" } : undefined}>
                      {v.isSecret ? (revealed.has(v.key) ? "•••• (hidden by the API)" : "••••••") : v.value}
                    </code>
                    {v.isSecret && (
                      <button className="ghost small" onClick={() => toggleReveal(v.key)}>
                        {revealed.has(v.key) ? "Hide" : "Reveal"}
                      </button>
                    )}
                    {canWrite && (
                      <div className="var-actions">
                        <button className="ghost small" onClick={() => startEdit(v)}>
                          Edit
                        </button>
                        <button className="ghost small danger-text" onClick={() => remove(v.key)}>
                          Remove
                        </button>
                      </div>
                    )}
                  </div>
                </>
              )}
            </li>
          );
        })}
        {list.data?.length === 0 && <li className="muted">No variables yet.</li>}
      </ul>

      {canWrite && (
        <div className="disclose">
          {!adding ? (
            <button className="disclose-trigger" onClick={() => setAdding(true)}>
              + Add variable
            </button>
          ) : (
            <form className="disclose-body inline wrap" onSubmit={createVariable}>
              <input
                value={newVar.key}
                onChange={(e) => setNewVar({ ...newVar, key: e.target.value.toUpperCase() })}
                placeholder="VARIABLE_NAME"
                aria-label="key"
                autoFocus
              />
              <input
                value={newVar.value}
                onChange={(e) => setNewVar({ ...newVar, value: e.target.value })}
                placeholder="value"
                aria-label="value"
              />
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={newVar.isSecret}
                  onChange={(e) => setNewVar({ ...newVar, isSecret: e.target.checked })}
                />
                secret
              </label>
              <button type="submit" disabled={!newKeyValid}>
                Save
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
