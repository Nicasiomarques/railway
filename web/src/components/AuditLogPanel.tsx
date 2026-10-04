import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiProblem, type AuditLogEntry } from "../api";

// GET /organizations/{organizationId}/audit-logs: built by another agent in parallel with this panel
// and may not exist yet in every environment. Until it ships, the request below 404s — that's expected,
// not a bug in this component (see the report for how this was validated).
export function AuditLogPanel({ organizationId }: { organizationId: string }) {
  const queryClient = useQueryClient();
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["audit-logs", organizationId, cursor],
    queryFn: () =>
      api<{ data: AuditLogEntry[]; nextCursor: string | null }>(
        `/organizations/${organizationId}/audit-logs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      ),
  });

  async function loadMore() {
    setError(null);
    try {
      if (list.data?.nextCursor) setCursor(list.data.nextCursor);
    } catch (err) {
      setError(err instanceof ApiProblem ? err.message : "Error loading audit logs.");
    }
  }

  function reset() {
    setCursor(null);
    queryClient.invalidateQueries({ queryKey: ["audit-logs", organizationId] });
  }

  return (
    <section className="audit-log">
      <div className="section-head">
        <h3>Audit log</h3>
        <button className="ghost small" onClick={reset}>
          Refresh
        </button>
      </div>

      {list.isError && (
        <p className="error">
          {list.error instanceof ApiProblem && list.error.status === 404
            ? "Audit log isn't available yet on this server."
            : list.error instanceof ApiProblem
              ? list.error.message
              : "Error loading audit logs."}
        </p>
      )}
      {error && <p className="error">{error}</p>}

      <table className="audit-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Action</th>
            <th>Target</th>
            <th>Actor</th>
          </tr>
        </thead>
        <tbody>
          {list.data?.data.map((entry) => (
            <tr key={entry.id}>
              <td className="muted">{new Date(entry.createdAt).toLocaleString()}</td>
              <td>{entry.action}</td>
              <td>{entry.target}</td>
              <td className="muted">{entry.actorId ?? "system"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.data?.data.length === 0 && <p className="muted">No audit log entries yet.</p>}

      {list.data?.nextCursor && (
        <button className="ghost small" onClick={loadMore}>
          Next page
        </button>
      )}
    </section>
  );
}
