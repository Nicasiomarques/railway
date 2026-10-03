import { useEffect, useRef, useState } from "react";
import type { Connection, Service } from "../api";

type Pos = { x: number; y: number };

const NODE_W = 200;
const NODE_H = 72;
const GAP = 24;
const COLS = 3;

// Positions live in localStorage per project. Persisting them in the backend requires its own endpoint.
function storageKey(projectId: string) {
  return `railway_like.canvas.${projectId}`;
}

function loadPositions(projectId: string): Record<string, Pos> {
  try {
    return JSON.parse(localStorage.getItem(storageKey(projectId)) ?? "{}");
  } catch {
    return {};
  }
}

// Default grid position for services that haven't been dragged yet.
function defaultPos(index: number): Pos {
  return {
    x: GAP + (index % COLS) * (NODE_W + GAP),
    y: GAP + Math.floor(index / COLS) * (NODE_H + GAP),
  };
}

type Node = { serviceId: string; instanceId: string; name: string; kind: string; source: string };

export function ServiceCanvas({
  projectId,
  services,
  connections,
  environment,
  canWrite,
  onConnect,
  onDisconnect,
}: {
  projectId: string;
  services: Service[];
  connections: Connection[];
  environment: string | null;
  canWrite: boolean;
  onConnect: (fromInstanceId: string, toInstanceId: string) => void;
  onDisconnect: (fromInstanceId: string, toInstanceId: string) => void;
}) {
  const [positions, setPositions] = useState<Record<string, Pos>>(() => loadPositions(projectId));
  const [linking, setLinking] = useState<{ fromInstanceId: string; x: number; y: number } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; startX: number; startY: number; origX: number; origY: number } | null>(null);

  // One node per service that has an instance in the selected environment.
  const nodes: Node[] = services.flatMap((s) => {
    const inst = s.instances.find((i) => i.environmentName === environment);
    return inst ? [{ serviceId: s.id, instanceId: inst.id, name: s.name, kind: s.kind, source: s.source }] : [];
  });
  const indexOfInstance = new Map(nodes.map((n, i) => [n.instanceId, i]));

  const posOf = (node: Node, index: number): Pos => positions[node.serviceId] ?? defaultPos(index);
  const center = (instanceId: string, side: "left" | "right"): Pos | null => {
    const i = indexOfInstance.get(instanceId);
    if (i === undefined) return null;
    const p = posOf(nodes[i], i);
    return { x: side === "right" ? p.x + NODE_W : p.x, y: p.y + NODE_H / 2 };
  };

  useEffect(() => {
    localStorage.setItem(storageKey(projectId), JSON.stringify(positions));
  }, [projectId, positions]);

  function onNodePointerDown(e: React.PointerEvent<HTMLDivElement>, node: Node, index: number) {
    e.currentTarget.setPointerCapture(e.pointerId);
    const origin = posOf(node, index);
    drag.current = { id: node.serviceId, startX: e.clientX, startY: e.clientY, origX: origin.x, origY: origin.y };
  }

  function onNodePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d) return;
    const x = Math.max(0, d.origX + e.clientX - d.startX);
    const y = Math.max(0, d.origY + e.clientY - d.startY);
    setPositions((p) => ({ ...p, [d.id]: { x, y } }));
  }

  function onNodePointerUp() {
    drag.current = null;
  }

  // Output port: dragging from it to another node creates the connection.
  function onPortPointerDown(e: React.PointerEvent<HTMLDivElement>, instanceId: string) {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = canvasRef.current!.getBoundingClientRect();
    setLinking({ fromInstanceId: instanceId, x: e.clientX - rect.left, y: e.clientY - rect.top });
  }

  function onPortPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!linking) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    setLinking({ ...linking, x: e.clientX - rect.left, y: e.clientY - rect.top });
  }

  function onPortPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!linking) return;
    // Pointer capture keeps the event on the port; elementFromPoint finds the target node.
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-instance-id]");
    const toInstanceId = target?.dataset.instanceId;
    if (toInstanceId && toInstanceId !== linking.fromInstanceId) {
      onConnect(linking.fromInstanceId, toInstanceId);
    }
    setLinking(null);
  }

  function resetLayout() {
    setPositions({});
  }

  const visibleConnections = connections.filter(
    (c) => indexOfInstance.has(c.fromInstanceId) && indexOfInstance.has(c.toInstanceId),
  );

  const height = Math.max(320, ...nodes.map((n, i) => posOf(n, i).y + NODE_H + GAP));

  return (
    <div className="canvas-wrap">
      <div className="canvas-toolbar">
        <span className="muted">
          {canWrite
            ? "Drag nodes to organize them. Drag the dot on the right to another node to connect them."
            : "Drag nodes to organize them."}
        </span>
        <button className="ghost" onClick={resetLayout}>
          Rearrange
        </button>
      </div>

      <div className="canvas" ref={canvasRef} style={{ height }}>
        <svg className="links" width="100%" height="100%">
          {visibleConnections.map((c) => {
            const from = center(c.fromInstanceId, "right")!;
            const to = center(c.toInstanceId, "left")!;
            const d = curve(from, to);
            return (
              <g key={`${c.fromInstanceId}-${c.toInstanceId}`} className={canWrite ? "link clickable" : "link"}>
                <path d={d} className="link-hit" onClick={() => canWrite && onDisconnect(c.fromInstanceId, c.toInstanceId)}>
                  <title>{canWrite ? "Click to remove the connection" : ""}</title>
                </path>
                <path d={d} className="link-line" />
              </g>
            );
          })}
          {linking && (() => {
            const from = center(linking.fromInstanceId, "right");
            return from ? <path d={curve(from, { x: linking.x, y: linking.y })} className="link-line draft" /> : null;
          })()}
        </svg>

        {nodes.length === 0 && <p className="muted canvas-empty">No services in this environment.</p>}

        {nodes.map((n, i) => {
          const pos = posOf(n, i);
          return (
            <div
              key={n.instanceId}
              data-instance-id={n.instanceId}
              className="node"
              style={{ left: pos.x, top: pos.y, width: NODE_W, height: NODE_H }}
              onPointerDown={(e) => onNodePointerDown(e, n, i)}
              onPointerMove={onNodePointerMove}
              onPointerUp={onNodePointerUp}
              onPointerCancel={onNodePointerUp}
            >
              <strong>{n.name}</strong>
              <span className="muted">
                {n.kind} · {n.source}
              </span>
              {canWrite && (
                <div
                  className="port"
                  onPointerDown={(e) => onPortPointerDown(e, n.instanceId)}
                  onPointerMove={onPortPointerMove}
                  onPointerUp={onPortPointerUp}
                  onPointerCancel={() => setLinking(null)}
                  title="Drag to connect"
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function curve(from: Pos, to: Pos): string {
  const dx = Math.max(40, Math.abs(to.x - from.x) / 2);
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
}
