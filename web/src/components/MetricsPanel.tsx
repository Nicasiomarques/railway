import { useQuery } from "@tanstack/react-query";
import { api, type MetricsSnapshot } from "../api";

const POLL_MS = 5000;

export function useInstanceMetrics(instanceId: string) {
  return useQuery({
    queryKey: ["metrics", instanceId],
    queryFn: () => api<MetricsSnapshot>(`/services/${instanceId}/metrics`),
    refetchInterval: POLL_MS,
  });
}

export function MetricsPanel({ instanceId }: { instanceId: string }) {
  const metrics = useInstanceMetrics(instanceId);

  return (
    <section className="metrics">
      <div className="section-head">
        <h3>Metrics</h3>
      </div>
      {metrics.isLoading && <p className="muted">Loading…</p>}
      {metrics.data && (
        <div className="metrics-grid">
          <div className="metric-tile">
            <span className="muted">Status</span>
            <span className={`status status-${metrics.data.status}`}>{metrics.data.status}</span>
          </div>
          <div className="metric-tile">
            <span className="muted">Replicas</span>
            <span className="value">
              {metrics.data.readyReplicas}/{metrics.data.replicas}
            </span>
          </div>
          <div className="metric-tile">
            <span className="muted">Image</span>
            <span className="faint">{metrics.data.image ?? "no image"}</span>
          </div>
        </div>
      )}
    </section>
  );
}
