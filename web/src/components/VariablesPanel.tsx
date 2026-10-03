import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiProblem, type Variable } from "../api";

// Mesma regra de chave aplicada pela API (api/src/routes/variables.ts).
const KEY_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;

export function VariablesPanel({ instanceId, canWrite }: { instanceId: string; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ key: "", value: "", isSecret: false });
  const [error, setError] = useState<string | null>(null);
  // Chaves cujo "mostrar" foi pedido explicitamente; nunca populado por padrão.
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
      // PUT faz upsert pela chave: o mesmo formulário serve para criar e para atualizar.
      await api(`/services/${instanceId}/variables/${key}`, {
        method: "PUT",
        json: { value: form.value, isSecret: form.isSecret },
      });
      setForm({ key: "", value: "", isSecret: false });
      queryClient.invalidateQueries({ queryKey: ["variables", instanceId] });
    } catch (err) {
      setError(err instanceof ApiProblem ? err.message : "Erro ao gravar variável.");
    }
  }

  async function remove(key: string) {
    if (!window.confirm(`Remover a variável ${key}?`)) return;
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
      setError(err instanceof ApiProblem ? err.message : "Erro ao remover variável.");
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

  // Preenche o formulário com a variável selecionada; secrets vêm sem valor (a API não o devolve).
  function edit(v: Variable) {
    setForm({ key: v.key, value: v.value ?? "", isSecret: v.isSecret });
  }

  const keyValid = KEY_PATTERN.test(form.key.trim());

  return (
    <section className="variables">
      <div className="section-head">
        <h3>Variáveis</h3>
      </div>

      {canWrite && (
        <form className="inline wrap" onSubmit={save}>
          <input
            value={form.key}
            onChange={(e) => setForm({ ...form, key: e.target.value.toUpperCase() })}
            placeholder="NOME_DA_VARIAVEL"
            aria-label="chave"
          />
          <input
            value={form.value}
            onChange={(e) => setForm({ ...form, value: e.target.value })}
            placeholder="valor"
            aria-label="valor"
          />
          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.isSecret}
              onChange={(e) => setForm({ ...form, isSecret: e.target.checked })}
            />
            secreta
          </label>
          <button type="submit" disabled={!keyValid}>
            Gravar
          </button>
        </form>
      )}
      {error && <p className="error">{error}</p>}

      <ul className="list">
        {list.data?.map((v) => (
          <li key={v.key} className="card-row">
            <div>
              <strong>{v.key}</strong>{" "}
              {/* Esta rota só lista variáveis da própria instância; a API ainda não
                  resolve/expõe herança de ambiente ou projeto para esta origem. */}
              <span className="pill">própria instância</span>
              {v.isSecret && <span className="chip">secreta</span>}
            </div>
            <div className="var-actions">
              <code>
                {v.isSecret
                  ? revealed.has(v.key)
                    ? "a API nunca devolve o valor de um secret — grave um novo valor para substituir"
                    : "••••••"
                  : v.value}
              </code>
              {v.isSecret && (
                <button className="ghost small" onClick={() => toggleReveal(v.key)}>
                  {revealed.has(v.key) ? "Ocultar" : "Mostrar"}
                </button>
              )}
              {canWrite && (
                <>
                  <button className="ghost small" onClick={() => edit(v)}>
                    Editar
                  </button>
                  <button className="ghost small" onClick={() => remove(v.key)}>
                    Remover
                  </button>
                </>
              )}
            </div>
          </li>
        ))}
        {list.data?.length === 0 && <li className="muted">Nenhuma variável ainda.</li>}
      </ul>
    </section>
  );
}
