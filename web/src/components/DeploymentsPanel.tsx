import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiProblem, TERMINAL_STATUSES, type Deployment, type DeploymentDetail } from "../api";

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*@sha256:[a-f0-9]{64}$/;

// Atualiza enquanto houver deployment em andamento; para quando todos chegam a um estado terminal.
function pollInterval(items: Deployment[] | undefined): number | false {
  return items?.some((d) => !TERMINAL_STATUSES.includes(d.status)) ? 3000 : false;
}

export function DeploymentsPanel({
  instanceId,
  serviceName,
  environmentName,
  source,
  canWrite,
  onClose,
}: {
  instanceId: string;
  serviceName: string;
  environmentName: string | null;
  source: string;
  canWrite: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [origin, setOrigin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const isRepo = source === "github_repo";

  const list = useQuery({
    queryKey: ["deployments", instanceId],
    queryFn: () => api<{ data: Deployment[] }>(`/services/${instanceId}/deployments`).then((r) => r.data),
    refetchInterval: (query) => pollInterval(query.state.data),
  });

  const detail = useQuery({
    queryKey: ["deployment", selectedId],
    queryFn: () => api<DeploymentDetail>(`/deployments/${selectedId}`),
    enabled: selectedId !== null,
    refetchInterval: (query) => pollInterval(query.state.data ? [query.state.data] : undefined),
  });

  const logs = useQuery({
    queryKey: ["deployment-logs", selectedId],
    queryFn: () => api<{ content: string; updatedAt: string | null }>(`/deployments/${selectedId}/logs`),
    enabled: selectedId !== null && detail.data?.commitSha != null,
    refetchInterval: detail.data && !TERMINAL_STATUSES.includes(detail.data.status) ? 3000 : false,
  });

  const originValid = isRepo ? SHA.test(origin) : DIGEST.test(origin);

  async function deploy(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const created = await api<Deployment>(`/services/${instanceId}/deployments`, {
        method: "POST",
        // Repetir o clique não cria outra versão: a chave é gerada uma vez por envio.
        headers: { "idempotency-key": crypto.randomUUID() },
        json: isRepo ? { commitSha: origin } : { imageDigest: origin },
      });
      setOrigin("");
      setSelectedId(created.id);
      queryClient.invalidateQueries({ queryKey: ["deployments", instanceId] });
    } catch (err) {
      setError(err instanceof ApiProblem ? err.message : "Erro ao criar deployment.");
    }
  }

  return (
    <section className="deployments">
      <div className="section-head">
        <h3>
          Deployments: {serviceName}
          {environmentName && <span className="muted"> · {environmentName}</span>}
        </h3>
        <button className="ghost" onClick={onClose}>
          Fechar
        </button>
      </div>

      {canWrite && (
        <form className="inline wrap" onSubmit={deploy}>
          <input
            value={origin}
            onChange={(e) => setOrigin(e.target.value.trim())}
            placeholder={isRepo ? "SHA completo do commit (40 hex)" : "repo@sha256:<64 hex>"}
            aria-label={isRepo ? "commit" : "digest da imagem"}
          />
          <button type="submit" disabled={!originValid}>
            Deploy
          </button>
        </form>
      )}
      {error && <p className="error">{error}</p>}

      <ul className="list">
        {list.data?.map((d) => (
          <li key={d.id}>
            <button
              className={d.id === selectedId ? "row active" : "row"}
              onClick={() => setSelectedId(d.id)}
            >
              <span>
                <strong>v{d.versionNo}</strong> <StatusPill status={d.status} />{" "}
                <span className="muted">{d.commitSha ? d.commitSha.slice(0, 7) : shortDigest(d.imageDigest)}</span>
              </span>
              <span className="muted">{new Date(d.createdAt).toLocaleString()}</span>
            </button>
          </li>
        ))}
        {list.data?.length === 0 && <li className="muted">Nenhum deployment ainda.</li>}
      </ul>

      {selectedId && detail.data && (
        <div className="timeline">
          <h4>
            v{detail.data.versionNo} · <StatusPill status={detail.data.status} />
          </h4>
          <p className="muted">
            {detail.data.commitSha ? `commit ${detail.data.commitSha}` : `imagem ${detail.data.imageDigest ?? "—"}`}
          </p>
          <ol>
            {detail.data.events.map((e, i) => (
              <li key={i}>
                <span className="muted">{new Date(e.occurredAt).toLocaleTimeString()}</span>{" "}
                {e.fromStatus ? `${e.fromStatus} → ` : ""}
                <strong>{e.toStatus}</strong>
                {e.reason && <span className="muted"> — {e.reason}</span>}
              </li>
            ))}
          </ol>
          {detail.data.commitSha && (
            <div className="build-logs">
              <h4>
                Logs do build
                {logs.data?.updatedAt && (
                  <span className="muted"> · atualizado {new Date(logs.data.updatedAt).toLocaleTimeString()}</span>
                )}
              </h4>
              <pre>{logs.data?.content || "Nenhum log ainda."}</pre>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function StatusPill({ status }: { status: string }) {
  return <span className={`status status-${status}`}>{status}</span>;
}

function shortDigest(digest: string | null): string {
  if (!digest) return "";
  return digest.split("@")[1]?.slice(7, 19) ?? digest;
}
