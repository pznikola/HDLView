import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Graph, Node } from "../types";
import type { LayoutResponse } from "../layout.worker";
import { pinSelected, pinTarget, type ConnectionTarget } from "../selection";
import { CONNECTOR, type LayoutView } from "../schematic-layout";
import type { SchematicPreferences } from "../schematic-display";
import {
  GEOMETRY_VERSION,
  boundaryDirection,
  pinTitle,
  symbolGeometry,
} from "../schematic-symbols";
import { SchematicSymbol, schematicStyle } from "./SchematicSymbol";
import { saveSchematicSvg } from "../api";

type Camera = { x: number; y: number; scale: number };
const MIN_SCALE = 0.05,
  MAX_SCALE = 5;
const EXPORT_MARGIN = 20;
/** Zoom steps at which pin hit areas and label detail are redrawn. */
const zoomLevel = (scale: number) => Math.floor(Math.log2(scale));

/** The drawn schematic as a standalone SVG: whole drawing, no interaction state. */
function standaloneSvg(
  canvas: SVGSVGElement,
  layout: LayoutView,
  theme: SchematicPreferences["theme"],
): string {
  const clone = canvas.cloneNode(true) as SVGSVGElement;
  const width = String((layout.graph.width ?? 1000) + 2 * EXPORT_MARGIN),
    height = String((layout.graph.height ?? 600) + 2 * EXPORT_MARGIN);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const style = clone.querySelector("style");
  if (style) style.textContent = schematicStyle(theme, false);
  clone.classList.remove("zoomed-out");
  clone.setAttribute(
    "viewBox",
    `${-EXPORT_MARGIN} ${-EXPORT_MARGIN} ${width} ${height}`,
  );
  clone.setAttribute("width", width);
  clone.setAttribute("height", height);
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
  background?.setAttribute("x", String(-EXPORT_MARGIN));
  background?.setAttribute("y", String(-EXPORT_MARGIN));
  background?.setAttribute("width", width);
  background?.setAttribute("height", height);
  return clone.outerHTML;
}
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
  // Panning and zooming move one transform; they never re-render the drawing.
  const camera = useRef<Camera>({ x: 20, y: 70, scale: 1 });
  const [level, setLevel] = useState(0);
  const [displayOpen, setDisplayOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const displayButton = useRef<HTMLButtonElement>(null);
  const ref = useRef<SVGSVGElement>(null);
  const drag = useRef<
    { x: number; y: number; cx: number; cy: number } | undefined
  >(undefined);
  const worker = useRef<Worker | undefined>(undefined);
  const laying = useRef(false);
  const sequence = useRef(0);
  const cache = useRef(
    new Map<string, { layout: LayoutView; camera?: Camera }>(),
  );
  const currentKey = useRef("");
  const fullControlWiring = preferences.full_control_wiring;
  const showCamera = useCallback(() => {
    const { x, y, scale } = camera.current;
    const transform = `translate(${x},${y}) scale(${scale})`;
    ref.current
      ?.querySelector("[data-world]")
      ?.setAttribute("transform", transform);
    const grid = ref.current?.querySelector("#schematic-grid");
    if (grid) {
      const spacing = String(
        24 *
          4 ** Math.max(0, Math.ceil(Math.log(8 / (24 * scale)) / Math.log(4))),
      );
      grid.setAttribute("patternTransform", transform);
      grid.setAttribute("width", spacing);
      grid.setAttribute("height", spacing);
      grid
        .querySelector("circle")
        ?.setAttribute("r", String(Math.max(0.8, 0.65 / scale)));
    }
    setLevel(zoomLevel(scale));
  }, []);
  const moveCamera = useCallback(
    (next: Camera) => {
      camera.current = next;
      showCamera();
    },
    [showCamera],
  );
  // React leaves the camera attributes alone; restore them on whatever it just drew.
  useLayoutEffect(showCamera);
  const zoom = (factor: number, x: number, y: number) => {
    const c = camera.current;
    const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, c.scale * factor));
    moveCamera({
      x: x - ((x - c.x) * scale) / c.scale,
      y: y - ((y - c.y) * scale) / c.scale,
      scale,
    });
  };
  const fit = useCallback(
    (view: LayoutView | undefined) => {
      if (!view || !ref.current) return;
      const bounds = ref.current.getBoundingClientRect();
      moveCamera({
        x: 32,
        y: 74,
        scale: Math.max(
          MIN_SCALE,
          Math.min(
            1.3,
            (bounds.width - 64) / (view.graph.width || 1),
            (bounds.height - 106) / (view.graph.height || 1),
          ),
        ),
      });
    },
    [moveCamera],
  );
  useEffect(() => {
    const key = JSON.stringify([
      GEOMETRY_VERSION,
      graph.nodes,
      graph.edges,
      fullControlWiring,
      graph.detail,
    ]);
    const previous = cache.current.get(currentKey.current);
    if (previous) previous.camera = camera.current;
    currentKey.current = key;
    const id = ++sequence.current;
    const cached = cache.current.get(key);
    if (cached) {
      setPending(false);
      setLayout(cached.layout);
      if (cached.camera) moveCamera(cached.camera);
      else fit(cached.layout);
      return;
    }
    setLayout(undefined);
    setPending(true);
    // An idle worker keeps its layout engine loaded; a busy one is working on a view nobody waits for.
    if (laying.current) worker.current?.terminate();
    if (laying.current || !worker.current)
      worker.current = new Worker(
        new URL("../layout.worker.ts", import.meta.url),
        { type: "module" },
      );
    const w = worker.current;
    laying.current = true;
    w.onmessage = ({ data }: MessageEvent<LayoutResponse>) => {
      laying.current = false;
      if (data.sequence !== sequence.current) return;
      setPending(false);
      if ("error" in data) {
        onError(data.error);
        return;
      }
      cache.current.set(key, { layout: data.result });
      if (cache.current.size > 30) {
        const first = cache.current.keys().next().value;
        if (first) cache.current.delete(first);
      }
      setLayout(data.result);
      fit(data.result);
    };
    w.onerror = (event) => {
      laying.current = false;
      if (id === sequence.current) {
        setPending(false);
        onError(event.message);
      }
      w.terminate();
      if (worker.current === w) worker.current = undefined;
    };
    w.postMessage({ sequence: id, graph, fullControlWiring });
  }, [graph, fullControlWiring, fit, moveCamera, onError]);
  useEffect(() => () => worker.current?.terminate(), []);
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
  const { renderNodes, geometries, placedPins } = useMemo(() => {
    const renderNodes = new Map(
      layout?.render_nodes.map((node) => [node.id, node]),
    );
    const geometries = new Map(
      layout?.render_nodes.map((node) => [node.id, symbolGeometry(node)]),
    );
    const placedPins = new Map(
      layout?.graph.children?.flatMap((placed) => {
        const node = renderNodes.get(placed.id);
        return node
          ? (geometries.get(node.id)?.pins ?? []).map(
              (anchor) =>
                [
                  anchor.id,
                  { x: placed.x ?? 0, y: placed.y ?? 0, node, anchor },
                ] as const,
            )
          : [];
      }),
    );
    return { renderNodes, geometries, placedPins };
  }, [layout]);
  return (
    <div className="schematic" data-theme={preferences.theme}>
      <div className="canvas-tools">
        <button onClick={() => fit(layout)}>Fit</button>
        <button
          aria-label="Zoom schematic in"
          onClick={() => zoom(1.3, camera.current.x, camera.current.y)}
        >
          ＋
        </button>
        <button
          aria-label="Zoom schematic out"
          onClick={() => zoom(1 / 1.3, camera.current.x, camera.current.y)}
        >
          −
        </button>
        <button
          onClick={() => {
            if (ref.current && layout)
              void saveSchematicSvg(
                standaloneSvg(ref.current, layout, preferences.theme),
              ).catch((error) => onError(String(error)));
          }}
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
          {graph.truncated ? ` · ${graph.omitted_cells} outside view` : ""}
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
              worker.current = undefined;
              laying.current = false;
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
      <svg
        ref={ref}
        aria-label="Schematic"
        className={`schematic-canvas ${level < -1 ? "zoomed-out" : ""}`}
        onWheel={(e) => {
          e.preventDefault();
          const rect = e.currentTarget.getBoundingClientRect();
          zoom(
            e.deltaY < 0 ? 1.12 : 1 / 1.12,
            e.clientX - rect.left,
            e.clientY - rect.top,
          );
        }}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) {
            drag.current = {
              x: e.clientX,
              y: e.clientY,
              cx: camera.current.x,
              cy: camera.current.y,
            };
            e.currentTarget.setPointerCapture(e.pointerId);
          }
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d)
            moveCamera({
              ...camera.current,
              x: d.cx + e.clientX - d.x,
              y: d.cy + e.clientY - d.y,
            });
        }}
        onPointerUp={() => {
          drag.current = undefined;
        }}
      >
        <style>{schematicStyle(preferences.theme)}</style>
        <rect
          className="canvas-background"
          width="100%"
          height="100%"
          pointerEvents="none"
        />
        {preferences.grid && (
          <>
            <defs>
              <pattern id="schematic-grid" patternUnits="userSpaceOnUse">
                <circle
                  cx="0"
                  cy="0"
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
        <g data-world>
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
                {wire.paths.map((path, i) => (
                  <g key={i}>
                    <path d={path.d} className="edge-hit" />
                    <path
                      d={path.d}
                      className={`edge ${path.width > 1 ? "bus" : ""} ${active ? "selected" : ""} ${context ? "context" : ""}`}
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
                  <text key={i} x={label.x} y={label.y} className="wire-label">
                    {label.text}
                  </text>
                ))}
              </g>
            );
          })}
          {layout?.graph.children?.map((placed) => {
            const node = renderNodes.get(placed.id);
            if (!node || node.kind === "net junction") return null;
            const geometry = geometries.get(node.id);
            if (!geometry) return null;
            const open = () => {
              if (node.display.detail) onDetail(node.display.detail);
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
                    (node.display.detail || node.child_scope)
                  ) {
                    e.preventDefault();
                    open();
                  }
                }}
              >
                <title>
                  {[node.label, node.kind, ...node.display.annotations].join(
                    "\n",
                  )}
                </title>
                <SchematicSymbol
                  node={node}
                  geometry={geometry}
                  selected={selected}
                  target={target}
                  scale={2 ** level}
                  onSignal={onSignal}
                />
                {(node.display.detail || node.child_scope) && (
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
            const placed = placedPins.get(connector.port_id),
              edge = edges.get(connector.edge_id);
            if (!placed || !edge) return null;
            const { node, anchor } = placed;
            const port = node.ports.find((p) => p.id === connector.port_id);
            if (!port) return null;
            const pin = {
              x: placed.x + anchor.x,
              y: placed.y + anchor.y,
            };
            const dx =
              anchor.side === "EAST"
                ? CONNECTOR
                : anchor.side === "WEST"
                  ? -CONNECTOR
                  : 0;
            const dy =
              anchor.side === "SOUTH"
                ? CONNECTOR
                : anchor.side === "NORTH"
                  ? -CONNECTOR
                  : 0;
            const active = pinSelected(port, selected, target);
            const activate = () =>
              onSignal(port.signal_ids, pinTarget(node, port));
            return (
              <g
                key={`${connector.edge_id}:${connector.port_id}`}
                role="button"
                tabIndex={0}
                aria-label={`${connector.label} control connection`}
                onClick={activate}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    activate();
                  }
                }}
              >
                <title>
                  {`${pinTitle(node, port)} · ${connector.label} connector`}
                </title>
                <path
                  className={`control-connector ${active ? "selected" : ""}`}
                  d={`M${pin.x},${pin.y} l${dx},${dy} m-3,-3 l3,3 l-3,3`}
                />
                {node.kind !== "port" && (
                  <text
                    x={pin.x + dx}
                    y={pin.y + dy - 6}
                    textAnchor={dx < 0 ? "end" : "start"}
                    className="wire-label"
                  >
                    {connector.label}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
