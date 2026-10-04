import type { DeploymentStatus } from "../api";

// The pipeline the spec asks for: Source -> Configuration -> Deploy -> Build -> Running, shown live
// as Queued -> Building -> Deploying -> Starting -> Running. The API's "HealthChecking" status is the
// "Starting" step (the instance is up and being health-checked before it's marked Running).
const STEPS: { status: DeploymentStatus; label: string }[] = [
  { status: "Queued", label: "Queued" },
  { status: "Building", label: "Building" },
  { status: "Deploying", label: "Deploying" },
  { status: "HealthChecking", label: "Starting" },
  { status: "Running", label: "Running" },
];

export function DeploymentPipeline({ status }: { status: DeploymentStatus }) {
  const failed = status === "Failed";
  const cancelled = status === "Cancelled" || status === "RolledBack" || status === "Superseded";
  // A superseded/rolled-back/cancelled deployment did reach some point in the pipeline; once it's not
  // actively in flight we just show the plain status pill instead of a stepper frozen mid-way.
  if (cancelled) {
    return <span className={`status status-${status}`}>{status}</span>;
  }

  // A terminal Failed status doesn't say which step failed, so we don't fake progress for it --
  // the steps stay unlit and a single "Failed" marker is appended instead.
  const currentIndex = failed ? -1 : STEPS.findIndex((s) => s.status === status);
  // Running is the pipeline's own terminal success state, not an in-flight step: it must render as
  // "done" (steady), not "active" (pulsing forever), or a finished deployment reads as still working.
  const isRunning = status === "Running";

  return (
    <ol className="pipeline" aria-label="Deployment pipeline">
      {STEPS.map((step, i) => {
        let state = "pending";
        if (i < currentIndex || (isRunning && i === currentIndex)) state = "done";
        else if (i === currentIndex) state = "active";
        return (
          <li key={step.status} className={`pipeline-step ${state}`}>
            <span className="pipeline-dot" />
            <span className="pipeline-label">{step.label}</span>
          </li>
        );
      })}
      {failed && (
        <li className="pipeline-step failed">
          <span className="pipeline-dot" />
          <span className="pipeline-label">Failed</span>
        </li>
      )}
    </ol>
  );
}
