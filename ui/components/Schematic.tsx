import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import type { Graph, Node } from "../types";
import type { LayoutResponse } from "../layout.worker";
import { pinSelected, pinTarget, type ConnectionTarget } from "../selection";
import { CONNECTOR, LARGE_VIEW, type LayoutView } from "../schematic-layout";
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
const MIN_SCALE = 0.005,
  MAX_SCALE = 5;
/** Below this zoom level a large view is drawn as outlines only. */
const OVERVIEW_LEVEL = -2;
type Box = [number, number, number, number];
const overlaps = (a: Box, b: Box) =>
  a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
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
  reveal,
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
  /** Changes when a selection made outside the schematic should come into view. */
  reveal?: number;
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
  // Panning and zooming move one transform; they re-render nothing until a large
  // view needs another part of its sheet.
  const camera = useRef<Camera>({ x: 20, y: 70, scale: 1 });
  const [level, setLevel] = useState(0);
  const [displayOpen, setDisplayOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const displayButton = useRef<HTMLButtonElement>(null);
  const ref = useRef<SVGSVGElement>(null);
  const drag = useRef<
    { x: number; y: number; cx: number; cy: number } | undefined
  >(undefined);
  // A large view draws only the part of the sheet around the window.
  const large = (layout?.graph.children?.length ?? 0) > LARGE_VIEW;
  const sheetWidth = layout?.graph.width ?? 0,
    sheetHeight = layout?.graph.height ?? 0;
  const sheet = useRef<[number, number] | undefined>(undefined);
  const mapWindow = useRef<HTMLDivElement>(null);
  const drawn = useRef<{ level: number; box: Box } | undefined>(undefined);
  const [region, setRegion] = useState<Box>();
  const [exporting, setExporting] = useState(false);
  useLayoutEffect(() => {
    sheet.current = large ? [sheetWidth, sheetHeight] : undefined;
  }, [large, sheetWidth, sheetHeight]);
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
    const level = zoomLevel(scale);
    setLevel(level);
    const bounds = ref.current?.getBoundingClientRect();
    if (!sheet.current || !bounds) return;
    const seen: Box = [
      -x / scale,
      -y / scale,
      (bounds.width - x) / scale,
      (bounds.height - y) / scale,
    ];
    const frame = mapWindow.current,
      map = frame?.parentElement;
    if (frame && map) {
      const kx = map.clientWidth / (sheet.current[0] || 1),
        ky = map.clientHeight / (sheet.current[1] || 1);
      const left = Math.max(0, seen[0] * kx),
        top = Math.max(0, seen[1] * ky);
      frame.style.left = `${left}px`;
      frame.style.top = `${top}px`;
      frame.style.width = `${Math.max(2, Math.min(map.clientWidth, seen[2] * kx) - left)}px`;
      frame.style.height = `${Math.max(2, Math.min(map.clientHeight, seen[3] * ky) - top)}px`;
    }
    const held = drawn.current;
    if (
      held?.level === level &&
      held.box[0] <= seen[0] &&
      held.box[1] <= seen[1] &&
      held.box[2] >= seen[2] &&
      held.box[3] >= seen[3]
    )
      return;
    // One window of margin on every side, so most pans draw nothing new.
    const width = seen[2] - seen[0],
      height = seen[3] - seen[1];
    const box: Box = [
      seen[0] - width,
      seen[1] - height,
      seen[2] + width,
      seen[3] + height,
    ];
    drawn.current = { level, box };
    setRegion(box);
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
  const { edges, portOwners } = useMemo(
    () => ({
      edges: new Map(graph.edges.map((edge) => [edge.id, edge])),
      portOwners: new Map(
        graph.nodes.flatMap((node) =>
          node.ports.map((port) => [port.id, node.label]),
        ),
      ),
    }),
    [graph],
  );
  const overview = large && level < OVERVIEW_LEVEL && !exporting;
  const shown = (box: Box) =>
    !large || exporting || (region !== undefined && overlaps(box, region));
  const { renderNodes, geometries, placedPins, outline } = useMemo(() => {
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
    const outline = large && {
      nodes: (layout?.graph.children ?? [])
        .filter((placed) => renderNodes.get(placed.id)?.kind !== "net junction")
        .map(
          (placed) =>
            `M${placed.x},${placed.y}h${placed.width}v${placed.height}h${-(placed.width ?? 0)}z`,
        )
        .join(""),
      wires: (layout?.wires ?? [])
        .flatMap((wire) => wire.paths.map((path) => path.d))
        .join(""),
    };
    return { renderNodes, geometries, placedPins, outline };
  }, [layout, large]);
  // Where the selection is drawn: its wires, else the cells it reaches, else the inspected cell.
  const focus = useMemo((): Box | undefined => {
    if (!layout) return undefined;
    const cells = (keep: (node: Node) => boolean) =>
      (layout.graph.children ?? []).flatMap((placed): Box[] => {
        const node = renderNodes.get(placed.id);
        const x = placed.x ?? 0,
          y = placed.y ?? 0;
        return node && keep(node)
          ? [[x, y, x + (placed.width ?? 0), y + (placed.height ?? 0)]]
          : [];
      });
    const wires = layout.wires
      .filter((wire) =>
        target
          ? target.kind === "wire" && target.wireId === wire.id
          : wire.signal_ids.includes(selected ?? ""),
      )
      .map((wire) => wire.box);
    const boxes = wires.length
      ? wires
      : target?.kind === "pin"
        ? cells((node) => node.id === target.nodeId)
        : selected
          ? cells((node) =>
              node.ports.some((port) => port.signal_ids.includes(selected)),
            )
          : [];
    const found = boxes.length ? boxes : cells((node) => node.id === inspected);
    return found.length
      ? [
          Math.min(...found.map((box) => box[0])),
          Math.min(...found.map((box) => box[1])),
          Math.max(...found.map((box) => box[2])),
          Math.max(...found.map((box) => box[3])),
        ]
      : undefined;
  }, [layout, renderNodes, selected, target, inspected]);
  const show = useCallback(
    (box: Box, always: boolean) => {
      const bounds = ref.current?.getBoundingClientRect();
      if (!bounds) return;
      const { x, y, scale } = camera.current;
      if (
        !always &&
        box[0] * scale + x >= 0 &&
        box[1] * scale + y >= 0 &&
        box[2] * scale + x <= bounds.width &&
        box[3] * scale + y <= bounds.height
      )
        return;
      const next = Math.max(
        MIN_SCALE,
        Math.min(
          1,
          (bounds.width - 160) / (box[2] - box[0] || 1),
          (bounds.height - 200) / (box[3] - box[1] || 1),
        ),
      );
      moveCamera({
        x: bounds.width / 2 - ((box[0] + box[2]) / 2) * next,
        y: bounds.height / 2 - ((box[1] + box[3]) / 2) * next,
        scale: next,
      });
    },
    [moveCamera],
  );
  useEffect(() => {
    if (reveal !== undefined && focus) show(focus, false);
  }, [reveal, focus, show]);
  const mapScale = Math.min(180 / (sheetWidth || 1), 240 / (sheetHeight || 1));
  const centre = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect(),
      bounds = ref.current?.getBoundingClientRect();
    if (!bounds) return;
    const { scale } = camera.current;
    moveCamera({
      x:
        bounds.width / 2 -
        ((e.clientX - rect.left) / rect.width) * sheetWidth * scale,
      y:
        bounds.height / 2 -
        ((e.clientY - rect.top) / rect.height) * sheetHeight * scale,
      scale,
    });
  };
  return (
    <div className="schematic" data-theme={preferences.theme}>
      <div className="canvas-tools">
        <button onClick={() => fit(layout)}>Fit</button>
        <button onClick={() => focus && show(focus, true)} disabled={!focus}>
          Show selection
        </button>
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
            if (!ref.current || !layout) return;
            // The file holds the whole sheet, whatever part is drawn now.
            flushSync(() => setExporting(true));
            const svg = standaloneSvg(ref.current, layout, preferences.theme);
            setExporting(false);
            void saveSchematicSvg(svg).catch((error) => onError(String(error)));
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
              <label>
                <input
                  type="checkbox"
                  checked={preferences.minimap}
                  onChange={(e) =>
                    onPreferences({
                      ...preferences,
                      minimap: e.target.checked,
                    })
                  }
                />
                Show minimap on large sheets
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
        className={`schematic-canvas ${level < -1 ? "zoomed-out" : ""} ${overview ? "overview" : ""}`}
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
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = undefined;
          // An outline has no elements to click: find the cell under the pointer.
          if (
            !overview ||
            !d ||
            Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4
          )
            return;
          const rect = e.currentTarget.getBoundingClientRect();
          const { x, y, scale } = camera.current;
          const px = (e.clientX - rect.left - x) / scale,
            py = (e.clientY - rect.top - y) / scale;
          const hit = layout?.graph.children?.find(
            (placed) =>
              (placed.x ?? 0) <= px &&
              px <= (placed.x ?? 0) + (placed.width ?? 0) &&
              (placed.y ?? 0) <= py &&
              py <= (placed.y ?? 0) + (placed.height ?? 0),
          );
          const node = hit && renderNodes.get(hit.id);
          if (node && node.kind !== "net junction") onInspect(node);
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
          {overview && outline && (
            <>
              <path className="edge" d={outline.wires} pointerEvents="none" />
              <path
                className="nodebox symbol-fill"
                d={outline.nodes}
                pointerEvents="none"
              />
            </>
          )}
          {layout?.wires.map((wire) => {
            const original = edges.get(wire.edge_id);
            if (!original) return null;
            const active = target
              ? target.kind === "wire" && target.wireId === wire.id
              : wire.signal_ids.includes(selected ?? "");
            if (overview ? !active : !shown(wire.box)) return null;
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
                {wire.paths.map((path, i) =>
                  overview || shown(path.box) ? (
                    <g key={i}>
                      <path d={path.d} className="edge-hit" />
                      <path
                        d={path.d}
                        className={`edge ${path.width > 1 ? "bus" : ""} ${active ? "selected" : ""} ${context ? "context" : ""}`}
                      />
                    </g>
                  ) : null,
                )}
                {wire.junctions.map((p, i) =>
                  overview || shown([p.x, p.y, p.x, p.y]) ? (
                    <circle
                      key={i}
                      cx={p.x}
                      cy={p.y}
                      r="2.5"
                      className="junction"
                    />
                  ) : null,
                )}
                {wire.labels.map((label, i) =>
                  shown([label.x, label.y, label.x, label.y]) ? (
                    <text
                      key={i}
                      x={label.x}
                      y={label.y}
                      className="wire-label"
                    >
                      {label.text}
                    </text>
                  ) : null,
                )}
              </g>
            );
          })}
          {layout?.graph.children?.map((placed) => {
            const node = renderNodes.get(placed.id);
            if (!node || node.kind === "net junction") return null;
            const geometry = geometries.get(node.id);
            if (!geometry) return null;
            const x = placed.x ?? 0,
              y = placed.y ?? 0;
            if (
              overview
                ? inspected !== node.id
                : !shown([x, y, x + geometry.width, y + geometry.height])
            )
              return null;
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
            if (overview || !shown([pin.x, pin.y, pin.x, pin.y])) return null;
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
      {outline && preferences.minimap && (
        <div
          className="schematic-minimap"
          aria-label="Schematic minimap"
          style={{
            width: Math.max(48, sheetWidth * mapScale),
            height: Math.max(48, sheetHeight * mapScale),
          }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            centre(e);
          }}
          onPointerMove={(e) => {
            if (e.buttons) centre(e);
          }}
        >
          <svg
            viewBox={`0 0 ${sheetWidth} ${sheetHeight}`}
            preserveAspectRatio="none"
          >
            <path d={outline.nodes} />
          </svg>
          {focus && (
            <div
              className="minimap-selection"
              style={{
                left: `${(100 * (focus[0] + focus[2])) / 2 / (sheetWidth || 1)}%`,
                top: `${(100 * (focus[1] + focus[3])) / 2 / (sheetHeight || 1)}%`,
              }}
            />
          )}
          <div className="minimap-window" ref={mapWindow} />
        </div>
      )}
    </div>
  );
}
