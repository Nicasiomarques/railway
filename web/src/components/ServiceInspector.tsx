import { useState } from "react";
import { DeploymentsPanel } from "./DeploymentsPanel";
import { VariablesPanel } from "./VariablesPanel";
import { LogsPanel } from "./LogsPanel";
import { MetricsPanel } from "./MetricsPanel";
import { DomainsPanel } from "./DomainsPanel";

type Tab = "deployments" | "variables" | "metrics" | "logs" | "domains" | "settings";

const TABS: { key: Tab; label: string }[] = [
  { key: "deployments", label: "Deployments" },
  { key: "variables", label: "Variables" },
  { key: "metrics", label: "Metrics" },
  { key: "logs", label: "Logs" },
  { key: "domains", label: "Domains" },
  { key: "settings", label: "Settings" },
];

// Clicking a node on the canvas opens this panel instead of stacking every section on the page:
// only the active tab's panel mounts, so a service that isn't being inspected costs nothing.
export function ServiceInspector({
  serviceId,
  instanceId,
  serviceName,
  environmentName,
  kind,
  source,
  rootDir,
  canWrite,
  onClose,
}: {
  serviceId: string;
  instanceId: string;
  serviceName: string;
  environmentName: string | null;
  kind: string;
  source: string;
  rootDir: string;
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
          {tab === "settings" && (
            <section className="settings">
              <div className="section-head">
                <h3>Settings</h3>
              </div>
              <ul className="list">
                <li className="card-row">
                  <span className="muted">Service</span>
                  <strong>{serviceName}</strong>
                </li>
                <li className="card-row">
                  <span className="muted">Kind</span>
                  <span className="pill">{kind}</span>
                </li>
                <li className="card-row">
                  <span className="muted">Source</span>
                  <span>{source}</span>
                </li>
                <li className="card-row">
                  <span className="muted">Root directory</span>
                  <code>{rootDir || "/"}</code>
                </li>
                <li className="card-row">
                  <span className="muted">Environment</span>
                  <span>{environmentName ?? "—"}</span>
                </li>
                <li className="card-row">
                  <span className="muted">Service ID</span>
                  <code>{serviceId}</code>
                </li>
                <li className="card-row">
                  <span className="muted">Instance ID</span>
                  <code>{instanceId}</code>
                </li>
              </ul>
              <p className="faint" style={{ marginTop: 12 }}>
                Rename, transfer and delete aren&apos;t exposed by the API yet, so they&apos;re not shown here.
              </p>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
