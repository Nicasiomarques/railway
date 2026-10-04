import { useState } from "react";
import { DeploymentsPanel } from "./DeploymentsPanel";
import { VariablesPanel } from "./VariablesPanel";
import { LogsPanel } from "./LogsPanel";
import { MetricsPanel } from "./MetricsPanel";
import { DomainsPanel } from "./DomainsPanel";

type Tab = "deployments" | "variables" | "metrics" | "logs" | "domains";

const TABS: { key: Tab; label: string }[] = [
  { key: "deployments", label: "Deployments" },
  { key: "variables", label: "Variables" },
  { key: "metrics", label: "Metrics" },
  { key: "logs", label: "Logs" },
  { key: "domains", label: "Domains" },
];

// Clicking a node on the canvas opens this panel instead of stacking every section on the page:
// only the active tab's panel mounts, so a service that isn't being inspected costs nothing.
export function ServiceInspector({
  instanceId,
  serviceName,
  environmentName,
  kind,
  source,
  canWrite,
  onClose,
}: {
  instanceId: string;
  serviceName: string;
  environmentName: string | null;
  kind: string;
  source: string;
  canWrite: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("deployments");

  return (
    <>
      <div className="inspector-overlay" onClick={onClose} />
      <div className="inspector" role="dialog" aria-label={`${serviceName} details`}>
        <div className="inspector-head">
          <div className="inspector-head-top">
            <div className="inspector-title">
              <strong>{serviceName}</strong>
              <span className="muted">
                <span className="pill">{kind}</span> <span className="pill">{source}</span>
                {environmentName && <span className="pill">{environmentName}</span>}
              </span>
            </div>
            <button className="ghost icon" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>
          <div className="inspector-tabs">
            {TABS.map((t) => (
              <button
                key={t.key}
                className={t.key === tab ? "inspector-tab active" : "inspector-tab"}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div className="inspector-body">
          {tab === "deployments" && (
            <DeploymentsPanel
              instanceId={instanceId}
              serviceName={serviceName}
              environmentName={environmentName}
              source={source}
              canWrite={canWrite}
              onClose={onClose}
              embedded
            />
          )}
          {tab === "variables" && <VariablesPanel instanceId={instanceId} canWrite={canWrite} />}
          {tab === "metrics" && <MetricsPanel instanceId={instanceId} />}
          {tab === "logs" && <LogsPanel instanceId={instanceId} />}
          {tab === "domains" && <DomainsPanel instanceId={instanceId} canWrite={canWrite} />}
        </div>
      </div>
    </>
  );
}
