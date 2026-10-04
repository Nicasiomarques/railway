import { useEffect, useRef, useState } from "react";
import type { CanvasLayout, Connection, Service } from "../api";
import { useInstanceMetrics } from "./MetricsPanel";
import { ServiceKindIcon } from "./ServiceKindIcon";

type Pos = { x: number; y: number };

const NODE_W = 200;
const NODE_H = 76;
const GAP = 24;
const COLS = 3;
// Debounce for persisting layout changes to the backend while dragging (pointermove fires per frame).
const SAVE_DEBOUNCE_MS = 500;
// Pointer movement under this, from pointerdown to pointerup, counts as a click (opens the
// inspector) rather than a drag (moves the node) -- the two share the same pointer handlers.
const CLICK_THRESHOLD_PX = 4;

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
  layout,
  openInstanceId,
  onLayoutChange,
  onConnect,
  onDisconnect,
  onOpenNode,
}: {
  projectId: string;
  services: Service[];
  connections: Connection[];
  environment: string | null;
  canWrite: boolean;
  layout: CanvasLayout;
  openInstanceId: string | null;
  onLayoutChange: (layout: CanvasLayout) => void;
  onConnect: (fromInstanceId: string, toInstanceId: string) => void;
  onDisconnect: (fromInstanceId: string, toInstanceId: string) => void;
  onOpenNode: (node: { serviceId: string; instanceId: string; name: string; kind: string; source: string }) => void;
}) {
  const [positions, setPositions] = useState<Record<string, Pos>>(layout);
  const [linking, setLinking] = useState<{ fromInstanceId: string; x: number; y: number } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; startX: number; startY: number; origX: number; origY: number; moved: boolean } | null>(
    null,
  );
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The server is the source of truth; resync local state whenever the project or its saved layout changes.
  useEffect(() => {
    setPositions(layout);
  }, [projectId, layout]);

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

  // Persists to the backend with a debounce: dragging fires a position update per pointermove.
  // Called only from the actions that actually change the layout (drag, reset) -- never from the
  // resync effect above -- so loading or refetching the saved layout doesn't write it right back.
  function scheduleSave(next: Record<string, Pos>) {
    if (!canWrite) return;
    setSaving(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      Promise.resolve(onLayoutChange(next)).finally(() => setSaving(false));
    }, SAVE_DEBOUNCE_MS);
  }

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  function onNodePointerDown(e: React.PointerEvent<HTMLDivElement>, node: Node, index: number) {
    e.currentTarget.setPointerCapture(e.pointerId);
    const origin = posOf(node, index);
    drag.current = { id: node.serviceId, startX: e.clientX, startY: e.clientY, origX: origin.x, origY: origin.y, moved: false };
  }

  function onNodePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) > CLICK_THRESHOLD_PX) {
      d.moved = true;
      setDraggingId(d.id);
    }
    if (!d.moved) return;
    const x = Math.max(0, d.origX + dx);
    const y = Math.max(0, d.origY + dy);
    setPositions((p) => {
      const next = { ...p, [d.id]: { x, y } };
      scheduleSave(next);
      return next;
    });
  }

  function onNodePointerUp(node: Node) {
    const d = drag.current;
    drag.current = null;
    setDraggingId(null);
    // A pointerdown/up pair with no meaningful movement is a click: open the inspector for it.
    if (d && !d.moved) {
      onOpenNode(node);
    }
  }

  // pointercancel means the gesture was interrupted (a touch scroll took over, pointer capture was
  // lost, a system gesture stepped in, ...) -- never a completed click, so it must not open the
  // inspector the way a genuine pointerup does. Only the drag/pointer-down state is cleared.
  function onNodePointerCancel() {
    drag.current = null;
    setDraggingId(null);
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
    scheduleSave({});
  }

  const visibleConnections = connections.filter(
    (c) => indexOfInstance.has(c.fromInstanceId) && indexOfInstance.has(c.toInstanceId),
  );

  const height = Math.max(280, ...nodes.map((n, i) => posOf(n, i).y + NODE_H + GAP));

  return (
    <div className="canvas-wrap">
      <div className="canvas-toolbar">
        <span className="muted">
          {canWrite
            ? "Clique num node para ver detalhes. Arraste para reorganizar, ou o ponto à direita para conectar."
            : "Clique num node para ver detalhes. Arraste para reorganizar."}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {saving && (
            <span className="saving-indicator">
              <span className="spinner" /> Saving…
            </span>
          )}
          <button className="ghost" onClick={resetLayout}>
            Rearrange
          </button>
        </span>
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
            <CanvasNode
              key={n.instanceId}
              node={n}
              pos={pos}
              canWrite={canWrite}
              isOpen={n.instanceId === openInstanceId}
              isDragging={n.serviceId === draggingId}
              onPointerDown={(e) => onNodePointerDown(e, n, i)}
              onPointerMove={onNodePointerMove}
              onPointerUp={() => onNodePointerUp(n)}
              onPointerCancel={onNodePointerCancel}
              onPortPointerDown={(e) => onPortPointerDown(e, n.instanceId)}
              onPortPointerMove={onPortPointerMove}
              onPortPointerUp={onPortPointerUp}
              onPortCancel={() => setLinking(null)}
            />
          );
        })}
      </div>
    </div>
  );
}

// Each node shows its own live status dot (polling .../metrics) so the canvas reads at a glance --
// "Indicador visual de atividade" -- without the inspector panel needing to be open.
function CanvasNode({
  node,
  pos,
  canWrite,
  isOpen,
  isDragging,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onPortPointerDown,
  onPortPointerMove,
  onPortPointerUp,
  onPortCancel,
}: {
  node: Node;
  pos: Pos;
  canWrite: boolean;
  isOpen: boolean;
  isDragging: boolean;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onPortPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPortPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPortPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPortCancel: () => void;
}) {
  // A canvas dot only needs a coarse, infrequent status -- the open inspector's Metrics tab already
  // polls the same endpoint every 5s for live detail, so this doesn't need to match that cadence.
  const metrics = useInstanceMetrics(node.instanceId, 15000);
  const status = metrics.data?.status ?? "unknown";

  let classes = "node";
  if (isOpen) classes += " open";
  if (isDragging) classes += " dragging";

  return (
    <div
      data-instance-id={node.instanceId}
      className={classes}
      style={{ left: pos.x, top: pos.y, width: NODE_W, height: NODE_H }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <div className="node-top">
        <span className="node-name">
          <span className={`status-dot dot-${status}`} title={status} />
          <ServiceKindIcon kind={node.kind} className="kind-icon" />
          {node.name}
        </span>
      </div>
      <span className="node-meta">
        {node.kind} · {node.source}
      </span>
      {canWrite && (
        <div
          className="port"
          onPointerDown={onPortPointerDown}
          onPointerMove={onPortPointerMove}
          onPointerUp={onPortPointerUp}
          onPointerCancel={onPortCancel}
          title="Drag to connect"
        />
      )}
    </div>
  );
}

function curve(from: Pos, to: Pos): string {
  const dx = Math.max(40, Math.abs(to.x - from.x) / 2);
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
}
