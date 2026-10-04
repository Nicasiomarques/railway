import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiProblem, type Organization, type UsageRow } from "../api";

type PeriodKey = "7d" | "30d";

const PERIODS: { key: PeriodKey; label: string; days: number }[] = [
  { key: "7d", label: "Last 7 days", days: 7 },
  { key: "30d", label: "Last 30 days", days: 30 },
];

// Fields assumed stable per the contract in api.ts's UsageRow. Anything else the
// API returns is treated as a metric and rendered as its own column, generically,
// since the exact metric names (totalReplicaMinutes, sampleCount, ...) aren't final.
const IDENTITY_KEYS = new Set(["projectId", "projectName", "serviceInstanceId", "serviceName"]);

function humanize(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}

function formatValue(value: unknown): string {
  if (typeof value === "number") return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(2);
  if (value === null || value === undefined) return "—";
  return String(value);
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function UsagePanel({ org }: { org: Organization }) {
  const [period, setPeriod] = useState<PeriodKey>("7d");
  const { days } = PERIODS.find((p) => p.key === period)!;

  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const fromParam = toIsoDate(from);
  const toParam = toIsoDate(to);

  const usage = useQuery({
    queryKey: ["usage", org.id, fromParam, toParam],
    queryFn: () =>
      api<{ data: UsageRow[] }>(`/organizations/${org.id}/usage?from=${fromParam}&to=${toParam}`).then(
        (r) => r.data,
      ),
  });

  const notFound = usage.error instanceof ApiProblem && usage.error.status === 404;

  // Union of every non-identity key across the returned rows, so the table adapts
  // to whatever metrics the backend actually sends instead of a hardcoded set.
  const metricKeys = Array.from(
    new Set(usage.data?.flatMap((row) => Object.keys(row).filter((k) => !IDENTITY_KEYS.has(k))) ?? []),
  );

  return (
    <section className="usage">
      <div className="section-head">
        <h3>Usage</h3>
      </div>

      <div className="inline">
        {PERIODS.map((p) => (
          <button key={p.key} className={p.key === period ? "tab active" : "tab"} onClick={() => setPeriod(p.key)}>
            {p.label}
          </button>
        ))}
      </div>

      {usage.isLoading && <p className="muted">Loading usage...</p>}

      {notFound && (
        <p className="muted">
          Usage reporting isn't available for this organization yet (the API doesn't expose this route, or you
          don't have permission to view it).
        </p>
      )}

      {usage.isError && !notFound && (
        <p className="error">{usage.error instanceof ApiProblem ? usage.error.message : "Error loading usage."}</p>
      )}

      {usage.data && (
        <table className="usage-table">
          <thead>
            <tr>
              <th>Project</th>
              <th>Service</th>
              {metricKeys.map((k) => (
                <th key={k}>{humanize(k)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {usage.data.map((row) => (
              <tr key={row.serviceInstanceId}>
                <td>{row.projectName}</td>
                <td>{row.serviceName}</td>
                {metricKeys.map((k) => (
                  <td key={k}>{formatValue(row[k])}</td>
                ))}
              </tr>
            ))}
            {usage.data.length === 0 && (
              <tr>
                <td colSpan={2 + metricKeys.length} className="muted">
                  No usage recorded for this period.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </section>
  );
}
