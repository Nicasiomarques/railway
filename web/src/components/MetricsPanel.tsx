import { useQuery } from "@tanstack/react-query";
import { api, type MetricsSnapshot } from "../api";

const POLL_MS = 5000;

export function MetricsPanel({ instanceId }: { instanceId: string }) {
  const metrics = useQuery({
    queryKey: ["metrics", instanceId],
    queryFn: () => api<MetricsSnapshot>(`/services/${instanceId}/metrics`),
    refetchInterval: POLL_MS,
  });

  return (
    <section className="metrics">
      <div className="section-head">
        <h3>Metrics</h3>
      </div>
      {metrics.isLoading && <p className="muted">Loading…</p>}
      {metrics.data && (
        <div className="card-row">
          <div>
            <span className={`status status-${metrics.data.status}`}>{metrics.data.status}</span>{" "}
            <span className="muted">
              {metrics.data.readyReplicas}/{metrics.data.replicas} ready
            </span>
          </div>
          <span className="muted">{metrics.data.image ?? "no image"}</span>
        </div>
      )}
    </section>
  );
}
