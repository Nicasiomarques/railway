import { useQuery } from "@tanstack/react-query";
import { api, ApiProblem, type MetricsSnapshot } from "../api";

const POLL_MS = 5000;

// `intervalMs` lets a caller that only needs a coarse status (e.g. a canvas dot, polled once per
// node) back off from the 5s cadence the open inspector's live metrics view uses, so the request
// volume doesn't scale linearly with how many services a project has.
export function useInstanceMetrics(instanceId: string, intervalMs: number = POLL_MS) {
  return useQuery({
    queryKey: ["metrics", instanceId],
    queryFn: () => api<MetricsSnapshot>(`/services/${instanceId}/metrics`),
    // Stop polling an endpoint that's already failing (e.g. no cluster backing this environment)
    // instead of hammering it every few seconds forever.
    refetchInterval: (query) => (query.state.error ? false : intervalMs),
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
      {metrics.isError && (
        <p className="muted">
          {metrics.error instanceof ApiProblem && metrics.error.status === 503
            ? "Metrics aren't available in this environment (no cluster backing the workload)."
            : metrics.error instanceof ApiProblem
              ? metrics.error.message
              : "Error loading metrics."}
        </p>
      )}
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
