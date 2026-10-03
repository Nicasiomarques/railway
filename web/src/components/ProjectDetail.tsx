import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, ApiProblem, type Connection, type Environment, type Service } from "../api";
import { ServiceCanvas } from "./ServiceCanvas";
import { DeploymentsPanel } from "./DeploymentsPanel";
import { VariablesPanel } from "./VariablesPanel";

const KINDS = ["web", "worker", "postgres", "redis"] as const;
const SOURCES = ["github_repo", "image", "template"] as const;

export function ProjectDetail({
  projectId,
  projectName,
  canWrite,
  onBack,
}: {
  projectId: string;
  projectName: string;
  canWrite: boolean;
  onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ name: "", kind: "web", source: "github_repo" });
  const [error, setError] = useState<string | null>(null);
  const [environment, setEnvironment] = useState<string | null>(null);
  const [deploying, setDeploying] = useState<{ instanceId: string; serviceName: string; source: string } | null>(null);

  const environments = useQuery({
    queryKey: ["environments", projectId],
    queryFn: () => api<{ data: Environment[] }>(`/projects/${projectId}/environments`).then((r) => r.data),
  });
  const services = useQuery({
    queryKey: ["services", projectId],
    queryFn: () => api<{ data: Service[] }>(`/projects/${projectId}/services`).then((r) => r.data),
  });

  const connections = useQuery({
    queryKey: ["connections", projectId],
    queryFn: () => api<{ data: Connection[] }>(`/projects/${projectId}/connections`).then((r) => r.data),
  });

  async function connect(fromInstanceId: string, toInstanceId: string) {
    setError(null);
    try {
      await api(`/projects/${projectId}/connections`, {
        method: "POST",
        json: { fromInstanceId, toInstanceId },
      });
      queryClient.invalidateQueries({ queryKey: ["connections", projectId] });
    } catch (err) {
      setError(err instanceof ApiProblem ? err.message : "Erro ao criar conexão.");
    }
  }

  async function disconnect(fromInstanceId: string, toInstanceId: string) {
    if (!window.confirm("Remover esta conexão?")) return;
    setError(null);
    try {
      await api(`/projects/${projectId}/connections?fromInstanceId=${fromInstanceId}&toInstanceId=${toInstanceId}`, {
        method: "DELETE",
      });
      queryClient.invalidateQueries({ queryKey: ["connections", projectId] });
    } catch (err) {
      setError(err instanceof ApiProblem ? err.message : "Erro ao remover conexão.");
    }
  }

  useEffect(() => {
    if (!environment && environments.data?.[0]) setEnvironment(environments.data[0].name);
  }, [environment, environments.data]);

  async function createService(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(`/projects/${projectId}/services`, {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        json: { name: form.name, kind: form.kind, source: form.source },
      });
      setForm({ ...form, name: "" });
      queryClient.invalidateQueries({ queryKey: ["services", projectId] });
    } catch (err) {
      setError(err instanceof ApiProblem ? err.message : "Erro ao criar serviço.");
    }
  }

  return (
    <section>
      <button className="ghost back" onClick={onBack}>
        ← Projetos
      </button>
      <div className="section-head">
        <h2>{projectName}</h2>
      </div>

      <h3>Ambientes</h3>
      <div className="chips">
        {environments.data?.map((env) => (
          <button
            key={env.id}
            className={env.name === environment ? "tab active" : "tab"}
            onClick={() => setEnvironment(env.name)}
          >
            {env.name}
          </button>
        ))}
      </div>

      <h3>Canvas</h3>
      {services.data && (
        <ServiceCanvas
          projectId={projectId}
          services={services.data}
          connections={connections.data ?? []}
          environment={environment}
          canWrite={canWrite}
          onConnect={connect}
          onDisconnect={disconnect}
        />
      )}

      <h3>Serviços</h3>
      {canWrite && (
        <form className="inline wrap" onSubmit={createService}>
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="nome-do-servico"
          />
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            {KINDS.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
          <select value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}>
            {SOURCES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <button type="submit" disabled={!form.name.trim()}>
            Adicionar serviço
          </button>
        </form>
      )}
      {error && <p className="error">{error}</p>}

      <ul className="list">
        {services.data?.map((s) => {
          const inEnv = s.instances.find((i) => i.environmentName === environment);
          return (
            <li key={s.id} className="card-row">
              <div>
                <strong>{s.name}</strong> <span className="pill">{s.kind}</span>{" "}
                <span className="muted">{s.source}</span>
              </div>
              <div className="chips">
                {s.instances.map((i) => (
                  <span key={i.id} className="chip">
                    {i.environmentName}
                  </span>
                ))}
                {inEnv && (
                  <button
                    className="ghost small"
                    onClick={() => setDeploying({ instanceId: inEnv.id, serviceName: s.name, source: s.source })}
                  >
                    Deployments
                  </button>
                )}
              </div>
            </li>
          );
        })}
        {services.data?.length === 0 && <li className="muted">Nenhum serviço ainda.</li>}
      </ul>

      {deploying && (
        <>
          <DeploymentsPanel
            key={deploying.instanceId}
            instanceId={deploying.instanceId}
            serviceName={deploying.serviceName}
            environmentName={environment}
            source={deploying.source}
            canWrite={canWrite}
            onClose={() => setDeploying(null)}
          />
          <VariablesPanel key={`${deploying.instanceId}-vars`} instanceId={deploying.instanceId} canWrite={canWrite} />
        </>
      )}
    </section>
  );
}
