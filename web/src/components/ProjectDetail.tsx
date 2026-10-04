import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, ApiProblem, type CanvasLayout, type Connection, type Environment, type Service } from "../api";
import { ServiceCanvas } from "./ServiceCanvas";
import { ServiceInspector } from "./ServiceInspector";

const KINDS = ["web", "worker", "postgres", "redis", "object_storage"] as const;
const SOURCES = ["github_repo", "image", "template", "minio_template"] as const;

type OpenNode = { serviceId: string; instanceId: string; name: string; kind: string; source: string };

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
  const [addingService, setAddingService] = useState(false);
  const [form, setForm] = useState({ name: "", kind: "web", source: "github_repo" });
  const [error, setError] = useState<string | null>(null);
  const [environment, setEnvironment] = useState<string | null>(null);
  const [open, setOpen] = useState<OpenNode | null>(null);

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

  const canvasLayout = useQuery({
    queryKey: ["canvas-layout", projectId],
    queryFn: () => api<{ layout: CanvasLayout }>(`/projects/${projectId}/canvas-layout`).then((r) => r.layout),
  });

  async function saveLayout(layout: CanvasLayout) {
    try {
      await api(`/projects/${projectId}/canvas-layout`, { method: "PATCH", json: { layout } });
      queryClient.setQueryData(["canvas-layout", projectId], layout);
    } catch (err) {
      setError(err instanceof ApiProblem ? err.message : "Error saving the canvas layout.");
    }
  }

  async function connect(fromInstanceId: string, toInstanceId: string) {
    setError(null);
    try {
      await api(`/projects/${projectId}/connections`, {
        method: "POST",
        json: { fromInstanceId, toInstanceId },
      });
      queryClient.invalidateQueries({ queryKey: ["connections", projectId] });
    } catch (err) {
      setError(err instanceof ApiProblem ? err.message : "Error creating connection.");
    }
  }

  async function disconnect(fromInstanceId: string, toInstanceId: string) {
    if (!window.confirm("Remove this connection?")) return;
    setError(null);
    try {
      await api(`/projects/${projectId}/connections?fromInstanceId=${fromInstanceId}&toInstanceId=${toInstanceId}`, {
        method: "DELETE",
      });
      queryClient.invalidateQueries({ queryKey: ["connections", projectId] });
    } catch (err) {
      setError(err instanceof ApiProblem ? err.message : "Error removing connection.");
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
      setAddingService(false);
      queryClient.invalidateQueries({ queryKey: ["services", projectId] });
    } catch (err) {
      setError(err instanceof ApiProblem ? err.message : "Error creating service.");
    }
  }

  const openService = open && services.data?.find((s) => s.id === open.serviceId);
  const openInstance = openService?.instances.find((i) => i.id === open?.instanceId);

  return (
    <section>
      <button className="ghost back" onClick={onBack}>
        ← Projects
      </button>
      <div className="section-head">
        <h2>{projectName}</h2>
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
      </div>

      {error && <p className="error">{error}</p>}

      {services.data && canvasLayout.data && (
        <ServiceCanvas
          projectId={projectId}
          services={services.data}
          connections={connections.data ?? []}
          environment={environment}
          canWrite={canWrite}
          layout={canvasLayout.data}
          openInstanceId={open?.instanceId ?? null}
          onLayoutChange={saveLayout}
          onConnect={connect}
          onDisconnect={disconnect}
          onOpenNode={setOpen}
        />
      )}

      <div className="section-head" style={{ marginTop: 28 }}>
        <h3>Services</h3>
      </div>

      <ul className="list">
        {services.data?.map((s) => {
          const inEnv = s.instances.find((i) => i.environmentName === environment);
          return (
            <li key={s.id}>
              <button
                className={open?.serviceId === s.id ? "row selected" : "row"}
                disabled={!inEnv}
                onClick={() =>
                  inEnv && setOpen({ serviceId: s.id, instanceId: inEnv.id, name: s.name, kind: s.kind, source: s.source })
                }
              >
                <span>
                  <strong>{s.name}</strong> <span className="pill">{s.kind}</span>{" "}
                  <span className="muted">{s.source}</span>
                </span>
                <span className="chips">
                  {s.instances.map((i) => (
                    <span key={i.id} className="chip">
                      {i.environmentName}
                    </span>
                  ))}
                </span>
              </button>
            </li>
          );
        })}
        {services.data?.length === 0 && <li className="muted">No services yet.</li>}
      </ul>

      {canWrite && (
        <div className="disclose">
          {!addingService ? (
            <button className="disclose-trigger" onClick={() => setAddingService(true)}>
              + Add service
            </button>
          ) : (
            <form className="disclose-body inline wrap" onSubmit={createService}>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="service-name"
                autoFocus
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
                Create
              </button>
              <button type="button" className="ghost" onClick={() => setAddingService(false)}>
                Cancel
              </button>
            </form>
          )}
        </div>
      )}

      {open && openInstance && openService && (
        <ServiceInspector
          instanceId={open.instanceId}
          serviceName={open.name}
          environmentName={openInstance.environmentName}
          kind={open.kind}
          source={open.source}
          canWrite={canWrite}
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  );
}
