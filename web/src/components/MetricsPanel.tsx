import { useQuery } from "@tanstack/react-query";
import { api, type MetricsSnapshot } from "../api";

const POLL_MS = 5000;

// `intervalMs` lets a caller that only needs a coarse status (e.g. a canvas dot, polled once per
// node) back off from the 5s cadence the open inspector's live metrics view uses, so the request
// volume doesn't scale linearly with how many services a project has.
export function useInstanceMetrics(instanceId: string, intervalMs: number = POLL_MS) {
  return useQuery({
    queryKey: ["metrics", instanceId],
    queryFn: () => api<MetricsSnapshot>(`/services/${instanceId}/metrics`),
    refetchInterval: intervalMs,
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
