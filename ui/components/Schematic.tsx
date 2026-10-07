import { useCallback, useEffect, useRef, useState } from "react";
import type { Graph, Node } from "../types";
import type { LayoutResponse } from "../layout.worker";
import type { ConnectionTarget } from "../selection";
import type { LayoutView } from "../schematic-layout";
import type { SchematicPreferences } from "../schematic-display";
import {
  GEOMETRY_VERSION,
  boundaryDirection,
  shortName,
  symbolGeometry,
} from "../schematic-symbols";
import { SchematicSymbol, schematicStyle } from "./SchematicSymbol";
import { saveSchematicSvg } from "../api";

type Camera = { x: number; y: number; scale: number };
export function Schematic({
  graph,
  splitBuses,
  onSplitBuses,
  selected,
  target,
  inspected,
  onSignal,
  onScope,
  onInspect,
  onDetail,
  onError,
  preferences,
  onPreferences,
}: {
  graph: Graph;
  splitBuses: boolean;
  onSplitBuses: () => void;
  selected?: string;
  target?: ConnectionTarget;
  inspected?: string;
  onSignal: (ids: string[], target?: ConnectionTarget) => void;
  onScope: (scope: string[]) => void;
  onInspect: (node: Node) => void;
  onDetail: (id: string) => void;
  onError: (e: string) => void;
  preferences: SchematicPreferences;
  onPreferences: (p: SchematicPreferences) => void;
}) {
  const [layout, setLayout] = useState<LayoutView>();
  const [pending, setPending] = useState(false);
  const [camera, setCamera] = useState<Camera>({ x: 20, y: 70, scale: 1 });
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const [displayOpen, setDisplayOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const displayButton = useRef<HTMLButtonElement>(null);
  const ref = useRef<SVGSVGElement>(null);
  const drag = useRef<
    { x: number; y: number; cx: number; cy: number } | undefined
  >(undefined);
  const worker = useRef<Worker | undefined>(undefined);
  const sequence = useRef(0);
  const cache = useRef(
    new Map<string, { layout: LayoutView; camera?: Camera }>(),
  );
  const currentKey = useRef("");
  const fullControlWiring = preferences.full_control_wiring;
  const fit = useCallback((view: LayoutView | undefined) => {
    if (!view || !ref.current) return;
    const bounds = ref.current.getBoundingClientRect();
    setCamera({
      x: 32,
      y: 74,
      scale: Math.max(
        0.05,
        Math.min(
          1.3,
          (bounds.width - 64) / (view.graph.width || 1),
          (bounds.height - 106) / (view.graph.height || 1),
        ),
      ),
    });
  }, []);
  useEffect(() => {
    const key = JSON.stringify([
      GEOMETRY_VERSION,
      graph.nodes,
      graph.edges,
      fullControlWiring,
      graph.detail,
    ]);
    const previous = cache.current.get(currentKey.current);
    if (previous) previous.camera = cameraRef.current;
    currentKey.current = key;
    const id = ++sequence.current;
    const cached = cache.current.get(key);
    if (cached) {
      setPending(false);
      setLayout(cached.layout);
      if (cached.camera) setCamera(cached.camera);
      else fit(cached.layout);
      return;
    }
    setLayout(undefined);
    setPending(true);
    const w = new Worker(new URL("../layout.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.current = w;
    w.onmessage = ({ data }: MessageEvent<LayoutResponse>) => {
      if (data.sequence !== sequence.current) return;
      setPending(false);
      if ("error" in data) {
        onError(data.error);
        w.terminate();
        return;
      }
      cache.current.set(key, { layout: data.result });
      if (cache.current.size > 30) {
        const first = cache.current.keys().next().value;
        if (first) cache.current.delete(first);
      }
      setLayout(data.result);
      fit(data.result);
      w.terminate();
    };
    w.onerror = (event) => {
      if (id === sequence.current) {
        setPending(false);
        onError(event.message);
      }
      w.terminate();
    };
    w.postMessage({ sequence: id, graph, fullControlWiring });
    return () => w.terminate();
  }, [graph, fullControlWiring, fit, onError]);
  useEffect(() => {
    if (!displayOpen) return;
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        !menu.current?.contains(event.target)
      )
        setDisplayOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDisplayOpen(false);
        displayButton.current?.focus();
      }
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", escape);
    };
  }, [displayOpen]);
  const edges = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const portOwners = new Map(
    graph.nodes.flatMap((node) =>
      node.ports.map((port) => [port.id, node.label]),
    ),
  );
  const renderNodes = new Map(
    layout?.render_nodes.map((node) => [node.id, node]),
  );
  const placedPorts = new Map(
    layout?.graph.children?.flatMap(
      (node) =>
        node.ports?.map(
          (port) =>
            [
              port.id,
              {
                x: (node.x ?? 0) + (port.x ?? 0),
                y: (node.y ?? 0) + (port.y ?? 0),
                node: renderNodes.get(node.id),
              },
            ] as const,
        ) ?? [],
    ),
  );
  const gridSpacing =
    24 *
    4 **
      Math.max(0, Math.ceil(Math.log(8 / (24 * camera.scale)) / Math.log(4)));
  async function exportSvg() {
    if (!ref.current || !layout) return;
    const clone = ref.current.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const style = clone.querySelector("style");
    if (style) style.textContent = schematicStyle(preferences.theme, false);
    clone.classList.remove("zoomed-out");
    clone.setAttribute(
      "viewBox",
      `-20 -20 ${(layout.graph.width ?? 1000) + 40} ${(layout.graph.height ?? 600) + 40}`,
    );
    clone.setAttribute("width", String((layout.graph.width ?? 1000) + 40));
    clone.setAttribute("height", String((layout.graph.height ?? 600) + 40));
    clone.querySelector("[data-world]")?.setAttribute("transform", "");
    for (const node of clone.querySelectorAll(
      ".selected,.object-selected,.context",
    ))
      node.classList.remove("selected", "object-selected", "context");
    for (const node of clone.querySelectorAll(
      ".edge-hit,.pin-hit,.expand,title,[data-grid],#schematic-grid",
    ))
      node.remove();
    const background = clone.querySelector(".canvas-background");
    background?.setAttribute("x", "-20");
    background?.setAttribute("y", "-20");
    background?.setAttribute(
      "width",
      String((layout.graph.width ?? 1000) + 40),
    );
    background?.setAttribute(
      "height",
      String((layout.graph.height ?? 600) + 40),
    );
    if (
      graph.edges.some(
        (edge) =>
          edge.semantics === "dependency" || edge.semantics === "control_flow",
      )
    ) {
      const legend = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "text",
      );
      legend.setAttribute("x", "0");
      legend.setAttribute("y", String((layout.graph.height ?? 600) + 12));
      legend.setAttribute("class", "wire-label");
      legend.textContent =
        "Dashed: source dependency · Dotted: procedural control";
      clone.append(legend);
    }
    await saveSchematicSvg(clone.outerHTML);
  }
  return (
    <div className="schematic" data-theme={preferences.theme}>
      <div className="canvas-tools">
        <button onClick={() => fit(layout)}>Fit</button>
        <button
          aria-label="Zoom schematic in"
          onClick={() =>
            setCamera((c) => ({ ...c, scale: Math.min(c.scale * 1.3, 5) }))
          }
        >
          ＋
        </button>
        <button
          aria-label="Zoom schematic out"
          onClick={() =>
            setCamera((c) => ({ ...c, scale: Math.max(c.scale / 1.3, 0.05) }))
          }
        >
          −
        </button>
        <button
          onClick={() =>
            void exportSvg().catch((error) => onError(String(error)))
          }
          disabled={!layout}
        >
          Export SVG
        </button>
        <button onClick={onSplitBuses}>
          {splitBuses ? "Collapse schematic buses" : "Expand schematic buses"}
        </button>
        <div className="schematic-display" ref={menu}>
          <button
            ref={displayButton}
            aria-expanded={displayOpen}
            aria-controls="schematic-display-menu"
            onClick={() => setDisplayOpen(!displayOpen)}
          >
            Display
          </button>
          {displayOpen && (
            <div
              id="schematic-display-menu"
              className="schematic-display-menu"
              role="group"
              aria-label="Schematic display"
            >
              <label>
                Canvas theme
                <select
                  aria-label="Canvas theme"
                  value={preferences.theme}
                  onChange={(e) =>
                    onPreferences({
                      ...preferences,
                      theme: e.target.value === "dark" ? "dark" : "light",
                    })
                  }
                >
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={!preferences.functional_symbols}
                  onChange={(e) =>
                    onPreferences({
                      ...preferences,
                      functional_symbols: !e.target.checked,
                    })
                  }
                />
                Show compiler nodes
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={preferences.full_control_wiring}
                  onChange={(e) =>
                    onPreferences({
                      ...preferences,
                      full_control_wiring: e.target.checked,
                    })
                  }
                />
                Full clock/reset wiring
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={preferences.show_physical_cells}
                  onChange={(e) =>
                    onPreferences({
                      ...preferences,
                      show_physical_cells: e.target.checked,
                    })
                  }
                />
                Show physical-only cells
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={preferences.grid}
                  onChange={(e) =>
                    onPreferences({ ...preferences, grid: e.target.checked })
                  }
                />
                Show grid
              </label>
            </div>
          )}
        </div>
        <span>
          {graph.total_cells} objects
          {graph.truncated ? ` · ${graph.omitted_cells ?? 0} outside view` : ""}
          {graph.hidden_physical_cells
            ? ` · ${graph.hidden_physical_cells} physical cells hidden`
            : ""}
        </span>
      </div>
      {pending && (
        <div className="layout-indicator">
          Laying out schematic…{" "}
          <button
            onClick={() => {
              ++sequence.current;
              worker.current?.terminate();
              setPending(false);
              currentKey.current = "";
              onError(
                "Layout cancelled. Navigate or change the view to restart.",
              );
            }}
          >
            Cancel layout
          </button>
        </div>
      )}
      {graph.edges.some((e) => e.semantics && e.semantics !== "electrical") && (
        <div className="schematic-legend">
          Dashed: source dependency · Dotted: procedural control
        </div>
      )}
      <svg
        ref={ref}
        aria-label="Schematic"
        className={`schematic-canvas ${camera.scale < 0.5 ? "zoomed-out" : ""}`}
        onWheel={(e) => {
          e.preventDefault();
          const rect = e.currentTarget.getBoundingClientRect();
          const x = e.clientX - rect.left,
            y = e.clientY - rect.top;
          setCamera((c) => {
            const scale = Math.max(
              0.05,
              Math.min(5, c.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12)),
            );
            return {
              x: x - ((x - c.x) * scale) / c.scale,
              y: y - ((y - c.y) * scale) / c.scale,
              scale,
            };
          });
        }}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) {
            drag.current = {
              x: e.clientX,
              y: e.clientY,
              cx: camera.x,
              cy: camera.y,
            };
            e.currentTarget.setPointerCapture(e.pointerId);
          }
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d)
            setCamera((c) => ({
              ...c,
              x: d.cx + e.clientX - d.x,
              y: d.cy + e.clientY - d.y,
            }));
        }}
        onPointerUp={() => {
          drag.current = undefined;
        }}
      >
        <style>{schematicStyle(preferences.theme)}</style>
        <defs>
          {(["dependency", "control_flow"] as const).map((semantics) => (
            <marker
              key={semantics}
              id={`arrow-${semantics}`}
              markerWidth="6"
              markerHeight="6"
              refX="6"
              refY="3"
              orient="auto"
              markerUnits="userSpaceOnUse"
            >
              <path
                d="M0,0 L6,3 L0,6 Z"
                fill={semantics === "control_flow" ? "#8d65ae" : "var(--muted)"}
              />
            </marker>
          ))}
        </defs>
        <rect
          className="canvas-background"
          width="100%"
          height="100%"
          pointerEvents="none"
        />
        {preferences.grid && (
          <>
            <defs>
              <pattern
                id="schematic-grid"
                width={gridSpacing}
                height={gridSpacing}
                patternTransform={`translate(${camera.x},${camera.y}) scale(${camera.scale})`}
                patternUnits="userSpaceOnUse"
              >
                <circle
                  cx="0"
                  cy="0"
                  r={Math.max(0.8, 0.65 / camera.scale)}
                  fill={preferences.theme === "light" ? "#91a7bb" : "#496f83"}
                />
              </pattern>
            </defs>
            <rect
              data-grid
              width="100%"
              height="100%"
              fill="url(#schematic-grid)"
              pointerEvents="none"
            />
          </>
        )}
        <g
          data-world
          transform={`translate(${camera.x},${camera.y}) scale(${camera.scale})`}
        >
          {layout?.wires.map((wire) => {
            const original = edges.get(wire.edge_id);
            if (!original) return null;
            const active = target
              ? target.kind === "wire" && target.wireId === wire.id
              : wire.signal_ids.includes(selected ?? "");
            const context =
              target?.kind === "pin" &&
              [...original.sources, ...original.targets].includes(
                target.portId,
              );
            const activate = () =>
              onSignal(wire.signal_ids, {
                kind: "wire",
                edgeId: wire.edge_id,
                wireId: wire.id,
              });
            return (
              <g
                key={wire.id}
                className={`wire ${active ? "selected" : ""}`}
                data-wire={wire.id}
                role="button"
                tabIndex={0}
                aria-label={original.label || "wire"}
                onClick={activate}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    activate();
                  }
                }}
              >
                <title>{`Wire ${original.label || "unnamed net"} · ${wire.width} bits · ${[...new Set([...original.sources, ...original.targets].map((id) => portOwners.get(id)).filter(Boolean))].join(" → ")}`}</title>
                {wire.paths.map((d, i) => (
                  <g key={i}>
                    <path d={d} className="edge-hit" />
                    <path
                      d={d}
                      className={`edge ${wire.width > 1 ? "bus" : ""} ${wire.semantics ?? "electrical"} ${active ? "selected" : ""} ${context ? "context" : ""}`}
                      markerEnd={
                        wire.semantics && wire.semantics !== "electrical"
                          ? `url(#arrow-${wire.semantics})`
                          : undefined
                      }
                    />
                  </g>
                ))}
                {wire.junctions.map((p, i) => (
                  <circle
                    key={i}
                    cx={p.x}
                    cy={p.y}
                    r="2.5"
                    className="junction"
                  />
                ))}
                {wire.labels.map((label, i) => (
                  <text
                    key={i}
                    x={label.x}
                    y={(label.y ?? 0) + 11}
                    className="wire-label"
                  >
                    {label.text}
                  </text>
                ))}
              </g>
            );
          })}
          {layout?.graph.children?.map((placed) => {
            const node = renderNodes.get(placed.id);
            if (!node || node.kind === "net junction") return null;
            const geometry = symbolGeometry(node);
            const open = () => {
              if (node.display?.detail) onDetail(node.display.detail);
              else if (node.child_scope) onScope(node.child_scope);
            };
            return (
              <g
                key={placed.id}
                className={inspected === node.id ? "object-selected" : ""}
                data-symbol={geometry.symbol}
                data-node={node.id}
                data-boundary={
                  node.kind === "port" ? boundaryDirection(node) : undefined
                }
                transform={`translate(${placed.x},${placed.y})`}
                role="button"
                tabIndex={0}
                aria-label={node.label}
                onClick={() => onInspect(node)}
                onDoubleClick={open}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onInspect(node);
                  }
                  if (
                    e.key === " " &&
                    (node.display?.detail || node.child_scope)
                  ) {
                    e.preventDefault();
                    open();
                  }
                }}
              >
                <title>
                  {node.label}\n{node.kind}
                  {node.display?.annotations.length
                    ? "\n" + node.display.annotations.join("\n")
                    : ""}
                </title>
                <SchematicSymbol
                  node={node}
                  selected={selected}
                  target={target}
                  scale={camera.scale}
                  onSignal={onSignal}
                />
                {(node.display?.detail || node.child_scope) && (
                  <g
                    role="button"
                    tabIndex={0}
                    aria-label={`Open ${node.label} details`}
                    onClick={(e) => {
                      e.stopPropagation();
                      open();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        e.stopPropagation();
                        open();
                      }
                    }}
                  >
                    <rect
                      x={geometry.width - 20}
                      y="0"
                      width="18"
                      height="18"
                      className="pin-hit"
                    />
                    <text x={geometry.width - 19} y="14" className="expand">
                      ⊞
                    </text>
                  </g>
                )}
              </g>
            );
          })}
          {layout?.connectors.map((connector) => {
            const pin = placedPorts.get(connector.port_id),
              edge = edges.get(connector.edge_id);
            if (!pin || !edge) return null;
            const node = pin.node,
              port = node?.ports.find((p) => p.id === connector.port_id);
            const anchor = node
              ? symbolGeometry(node).pins.find(
                  (p) => p.id === connector.port_id,
                )
              : undefined;
            if (!port || !anchor || !node) return null;
            const dx =
              anchor.side === "EAST" ? 18 : anchor.side === "WEST" ? -18 : 0;
            const dy = anchor.side === "SOUTH" ? 16 : 0;
            const active = target
              ? target.kind === "pin" && target.portId === port.id
              : port.signal_ids.includes(selected ?? "");
            return (
              <g
                key={`${connector.edge_id}:${connector.port_id}`}
                role="button"
                tabIndex={0}
                aria-label={`${connector.label} control connection`}
                onClick={() =>
                  onSignal(port.signal_ids, {
                    kind: "pin",
                    nodeId: node.id,
                    portId: port.id,
                  })
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSignal(port.signal_ids, {
                      kind: "pin",
                      nodeId: node.id,
                      portId: port.id,
                    });
                  }
                }}
              >
                <title>
                  {`Pin ${port.display?.name ?? port.label} · ${node.label} · ${port.display?.width ?? 1} bits · ${connector.label} connector`}
                </title>
                <path
                  className={`control-connector ${active ? "selected" : ""}`}
                  d={`M${pin.x},${pin.y} l${dx},${dy} m-3,-3 l3,3 l-3,3`}
                />
                <text
                  x={pin.x + dx}
                  y={pin.y + dy - 6}
                  textAnchor={dx < 0 ? "end" : "start"}
                  className="wire-label"
                >
                  {shortName(connector.label, 18)}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
