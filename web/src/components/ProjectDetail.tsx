import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, ApiProblem, type CanvasLayout, type Connection, type Deployment, type Environment, type Service } from "../api";
import { ServiceCanvas } from "./ServiceCanvas";
import { ServiceInspector } from "./ServiceInspector";
import { ServiceKindIcon } from "./ServiceKindIcon";

const KINDS = ["web", "worker", "postgres", "redis", "object_storage"] as const;
const SOURCES = ["github_repo", "image", "template", "postgres_template", "redis_template", "minio_template"] as const;

type OpenNode = { serviceId: string; instanceId: string; name: string; kind: string; source: string };

export function ProjectDetail({
  projectId,
  projectName,
  canWrite,
}: {
  projectId: string;
  projectName: string;
  canWrite: boolean;
}) {
  const queryClient = useQueryClient();
  const [addingService, setAddingService] = useState(false);
  const [form, setForm] = useState({ name: "", kind: "web", source: "github_repo" });
  const [error, setError] = useState<string | null>(null);
  const [environment, setEnvironment] = useState<string | null>(null);
  const [open, setOpen] = useState<OpenNode | null>(null);
  const [servicesOpen, setServicesOpen] = useState(false);
  // Set when "Add ..." is picked from the canvas's right-click menu: the next service created
  // through the form below lands at this canvas position instead of the default grid slot.
  const pendingPosRef = useRef<{ x: number; y: number } | null>(null);
  const addFormRef = useRef<HTMLFormElement>(null);

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
      const created = await api<Service>(`/projects/${projectId}/services`, {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        json: { name: form.name, kind: form.kind, source: form.source },
      });
      setForm({ ...form, name: "" });
      setAddingService(false);
      queryClient.invalidateQueries({ queryKey: ["services", projectId] });
      // Dropped from the canvas's "Add..." context menu: place the new node where the user
      // right-clicked instead of leaving it at the default grid slot.
      if (pendingPosRef.current && canvasLayout.data) {
        await saveLayout({ ...canvasLayout.data, [created.id]: pendingPosRef.current });
      }
    } catch (err) {
      setError(err instanceof ApiProblem ? err.message : "Error creating service.");
    } finally {
      pendingPosRef.current = null;
    }
  }

  // Background right-click on the canvas: opens the existing "Add service" disclosure, pre-filled
  // when a quick database/storage pick was chosen, and remembers where to drop the new node.
  function addAt(pos: { x: number; y: number }, preset?: { kind: string; source: string }) {
    setError(null);
    pendingPosRef.current = pos;
    setForm((f) => ({ name: "", kind: preset?.kind ?? f.kind, source: preset?.source ?? f.source }));
    setServicesOpen(true);
    setAddingService(true);
    requestAnimationFrame(() => addFormRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }));
  }

  // Right-click "Redeploy latest" on a node: reuses the same POST .../deployments the Deployments
  // tab's "Deploy" button calls, just supplying the previous deployment's own commit/image instead
  // of asking the user to retype it.
  async function redeployLatest(instanceId: string) {
    setError(null);
    try {
      const [latest] = await api<{ data: Deployment[] }>(`/services/${instanceId}/deployments?limit=1`).then((r) => r.data);
      if (!latest) {
        setError("This service has no deployments yet — deploy it from the Deployments tab first.");
        return;
      }
      await api(`/services/${instanceId}/deployments`, {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        json: latest.commitSha ? { commitSha: latest.commitSha } : { imageDigest: latest.imageDigest },
      });
      queryClient.invalidateQueries({ queryKey: ["deployments", instanceId] });
    } catch (err) {
      setError(err instanceof ApiProblem ? err.message : "Error redeploying.");
    }
  }

  const openService = open && services.data?.find((s) => s.id === open.serviceId);
  const openInstance = openService?.instances.find((i) => i.id === open?.instanceId);

  return (
    <section>
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

      {(services.isLoading || canvasLayout.isLoading) && <div className="skeleton canvas-skeleton" />}
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
          onAddAt={canWrite ? addAt : undefined}
          onRedeploy={canWrite ? redeployLatest : undefined}
        />
      )}

      <div className="section-head" style={{ marginTop: 14 }}>
        <button className="disclose-trigger subtle" onClick={() => setServicesOpen((v) => !v)}>
          <span className={servicesOpen ? "chevron open" : "chevron"}>▸</span>
          Services {services.data ? `(${services.data.length})` : ""}
        </button>
      </div>

      {servicesOpen && (
        <>
          {services.isLoading && (
            <ul className="list">
              <li className="skeleton" style={{ height: 44 }} />
              <li className="skeleton" style={{ height: 44 }} />
            </ul>
          )}
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
                      <strong>{s.name}</strong>{" "}
                      <span className="pill">
                        <ServiceKindIcon kind={s.kind} className="kind-icon" /> {s.kind}
                      </span>{" "}
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
                <form ref={addFormRef} className="disclose-body inline wrap" onSubmit={createService}>
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
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => {
                      pendingPosRef.current = null;
                      setAddingService(false);
                    }}
                  >
                    Cancel
                  </button>
                </form>
              )}
            </div>
          )}
        </>
      )}

      {open && openInstance && openService && (
        <ServiceInspector
          key={open.instanceId}
          serviceId={open.serviceId}
          instanceId={open.instanceId}
          serviceName={open.name}
          environmentName={openInstance.environmentName}
          kind={open.kind}
          source={open.source}
          rootDir={openService.rootDir}
          canWrite={canWrite}
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  );
}
