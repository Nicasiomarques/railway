import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiProblem, tokenStore, type Deployment } from "../api";

type StreamKind = "build" | "runtime";

// This panel isn't given a deploymentId: it always tails the instance's current deployment.
// We prefer the most recent `Running` one, since that's the deployment actually serving traffic
// and the most useful target for runtime logs; if none is Running yet (e.g. the latest deployment
// is still queued/building), we fall back to the most recent deployment overall so an in-progress
// build can still be watched. The caller may instead pass a specific deploymentId if it has one.
export function LogsPanel({ instanceId, deploymentId }: { instanceId: string; deploymentId?: string }) {
  const [stream, setStream] = useState<StreamKind>("build");
  const [lines, setLines] = useState<string[]>([]);
  const [tailing, setTailing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);

  const deployments = useQuery({
    queryKey: ["deployments", instanceId],
    queryFn: () => api<{ data: Deployment[] }>(`/services/${instanceId}/deployments`).then((r) => r.data),
    enabled: deploymentId === undefined,
  });
  const deployment = deploymentId
    ? ({ id: deploymentId } as Pick<Deployment, "id" | "versionNo">)
    : deployments.data?.find((d) => d.status === "Running") ?? deployments.data?.[0] ?? null;

  // Snapshot shown when no tail is running, matching what GET .../logs returns without `?stream`.
  const snapshot = useQuery({
    queryKey: ["deployment-logs-snapshot", deployment?.id],
    queryFn: () => api<{ content: string; updatedAt: string | null }>(`/deployments/${deployment!.id}/logs`),
    enabled: deployment != null && !tailing,
  });

  function stop() {
    abortRef.current?.abort();
  }

  // Streams via fetch + ReadableStream rather than EventSource: EventSource can't send the
  // Authorization header and the API only accepts bearer tokens there (api/src/auth.ts), so we'd
  // otherwise have to pass the token in the query string (and extend the backend to accept that).
  // fetch lets us keep sending the normal Authorization header and just parse the
  // `data: <line>\n\n` SSE framing ourselves, with no backend change required.
  async function start() {
    if (!deployment) return;
    setError(null);
    setLines([]);
    setTailing(true);
    const controller = new AbortController();
    abortRef.current = controller;

    const token = tokenStore.get();
    const headers: HeadersInit = {};
    if (token) headers.authorization = `Bearer ${token}`;

    try {
      const res = await fetch(`/v1/deployments/${deployment.id}/logs?stream=${stream}`, {
        headers,
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const problem = await res.json().catch(() => ({}));
        throw new ApiProblem(res.status, problem.code ?? "error", problem.detail ?? "Could not open the log stream.");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line; split out each complete `data: <line>` frame.
        let sep = buffer.indexOf("\n\n");
        while (sep !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const raw of frame.split("\n")) {
            if (raw.startsWith("data:")) setLines((prev) => [...prev, raw.slice(5).replace(/^ /, "")]);
          }
          sep = buffer.indexOf("\n\n");
        }
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError(err instanceof ApiProblem ? err.message : "Error streaming logs.");
      }
    } finally {
      setTailing(false);
      abortRef.current = null;
    }
  }

  // Stops any open tail on unmount, or when the target deployment changes from under us.
  useEffect(() => () => abortRef.current?.abort(), [deployment?.id]);

  // Keeps the view pinned to the newest line as they arrive.
  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [lines]);

  return (
    <section className="logs">
      <div className="section-head">
        <h3>Logs</h3>
        <div className="logs-controls">
          <select value={stream} onChange={(e) => setStream(e.target.value as StreamKind)} disabled={tailing}>
            <option value="build">build</option>
            <option value="runtime">runtime</option>
          </select>
          {tailing ? (
            <button className="ghost" onClick={stop}>
              Stop
            </button>
          ) : (
            <button onClick={start} disabled={!deployment}>
              Start tail
            </button>
          )}
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {!deployment && <p className="muted">No deployments yet.</p>}

      {tailing || lines.length > 0 ? (
        <pre ref={preRef} className="terminal">
          {lines.length > 0 ? lines.join("\n") : "Waiting for logs…"}
        </pre>
      ) : (
        <pre className="terminal">{snapshot.data?.content || "No logs yet."}</pre>
      )}
    </section>
  );
}
