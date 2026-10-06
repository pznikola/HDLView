import { useCallback, useEffect, useRef, useState } from "react";
import type { Graph, Node } from "../types";
import type { ElkNode } from "elkjs";
import type { LayoutResponse } from "../layout.worker";

export function Schematic({
  graph,
  splitBuses,
  onSplitBuses,
  selected,
  onSignal,
  onScope,
  onInspect,
  onError,
}: {
  graph: Graph;
  splitBuses: boolean;
  onSplitBuses: () => void;
  selected?: string;
  onSignal: (ids: string[]) => void;
  onScope: (scope: string[]) => void;
  onInspect: (node: Node) => void;
  onError: (e: string) => void;
}) {
  const [layout, setLayout] = useState<ElkNode>();
  const [pending, setPending] = useState(false);
  const [camera, setCamera] = useState({ x: 20, y: 20, scale: 1 });
  const ref = useRef<SVGSVGElement>(null);
  const drag = useRef<
    { x: number; y: number; cx: number; cy: number } | undefined
  >(undefined);
  const worker = useRef<Worker | undefined>(undefined);
  const seq = useRef(0);
  const cache = useRef(new Map<string, ElkNode>());
  const fit = useCallback((l: ElkNode | undefined) => {
    if (l && ref.current) {
      const rect = ref.current.getBoundingClientRect();
      setCamera({
        x: 30,
        y: 30,
        scale: Math.min(
          1.3,
          (rect.width - 60) / (l.width || 1),
          (rect.height - 60) / (l.height || 1),
        ),
      });
    }
  }, []);
  useEffect(() => {
    const key = JSON.stringify([graph.nodes, graph.edges]);
    const sequence = ++seq.current;
    const cached = cache.current.get(key);
    if (cached) {
      setPending(false);
      setLayout(cached);
      fit(cached);
      return;
    }
    const w = new Worker(new URL("../layout.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.current = w;
    setPending(true);
    w.onmessage = ({ data }: MessageEvent<LayoutResponse>) => {
      if (data.sequence !== seq.current) return;
      setPending(false);
      if ("error" in data) {
        onError(data.error);
        w.terminate();
        return;
      }
      cache.current.set(key, data.result);
      if (cache.current.size > 30)
        cache.current.delete(cache.current.keys().next().value!);
      setLayout(data.result);
      fit(data.result);
      w.terminate();
    };
    w.onerror = (event) => {
      setPending(false);
      onError(event.message);
      w.terminate();
    };
    w.postMessage({ sequence, graph });
    return () => w.terminate();
  }, [graph, fit, onError]);
  function exportSvg() {
    if (!ref.current) return;
    const clone = ref.current.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute(
      "viewBox",
      `0 0 ${layout?.width || 1000} ${layout?.height || 600}`,
    );
    clone.querySelector("[data-world]")?.setAttribute("transform", "");
    const style = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "style",
    );
    style.textContent =
      ".edge{fill:none;stroke:#697e93;stroke-width:1.5}.nodebox{fill:#edf4fa;stroke:#526779;rx:6}text{fill:#172a3a;font:12px sans-serif}.port{fill:#5e96ac}.selected{stroke:#20a9aa;stroke-width:3}";
    clone.prepend(style);
    const url = URL.createObjectURL(
      new Blob([clone.outerHTML], { type: "image/svg+xml" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "hdlview-schematic.svg";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="schematic">
      <div className="canvas-tools">
        <button onClick={() => fit(layout)}>Fit</button>
        <button
          onClick={() =>
            setCamera((c) => ({ ...c, scale: Math.min(c.scale * 1.3, 4) }))
          }
        >
          ＋
        </button>
        <button
          onClick={() =>
            setCamera((c) => ({ ...c, scale: Math.max(c.scale / 1.3, 0.05) }))
          }
        >
          −
        </button>
        <button onClick={exportSvg}>Export SVG</button>
        <button onClick={onSplitBuses}>
          {splitBuses ? "Collapse schematic buses" : "Expand schematic buses"}
        </button>
        <span>
          {graph.total_cells} cells {graph.truncated ? "· bounded view" : ""}
        </span>
      </div>
      {pending && (
        <div className="layout-indicator">
          Laying out schematic…{" "}
          <button
            onClick={() => {
              ++seq.current;
              worker.current?.terminate();
              setPending(false);
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
        <defs>
          <pattern
            id="grid"
            width="24"
            height="24"
            patternUnits="userSpaceOnUse"
          >
            <circle cx="1" cy="1" r=".7" fill="#304151" />
          </pattern>
        </defs>
        <rect
          width="100%"
          height="100%"
          fill="url(#grid)"
          pointerEvents="none"
        />
        <g
          data-world
          transform={`translate(${camera.x},${camera.y}) scale(${camera.scale})`}
        >
          {layout?.edges?.map((e) => {
            const original = graph.edges.find((x) =>
              e.id.startsWith(x.id + "/"),
            );
            const active = original?.signal_ids.includes(selected || "");
            return (
              <g
                key={e.id}
                onClick={() => original && onSignal(original.signal_ids)}
                role="button"
                aria-label={original?.label || "wire"}
              >
                {e.sections?.map((section, i) => {
                  const points = [
                    section.startPoint,
                    ...(section.bendPoints || []),
                    section.endPoint,
                  ];
                  const d = points
                    .map((p, j) => `${j ? "L" : "M"}${p.x},${p.y}`)
                    .join(" ");
                  return (
                    <g key={i}>
                      <path d={d} className="edge-hit" />
                      <path
                        d={d}
                        className={`edge ${active ? "selected" : ""}`}
                      />
                    </g>
                  );
                })}
                {e.labels?.map((l, i) => (
                  <text
                    key={i}
                    x={l.x}
                    y={(l.y || 0) + 10}
                    className="wire-label"
                  >
                    {l.text}
                  </text>
                ))}
              </g>
            );
          })}
          {layout?.children?.map((n) => {
            const original = graph.nodes.find((x) => x.id === n.id);
            if (!original) return null;
            return (
              <g
                key={n.id}
                transform={`translate(${n.x},${n.y})`}
                onClick={() => onInspect(original)}
                onDoubleClick={() =>
                  original.child_scope && onScope(original.child_scope)
                }
                role="button"
                aria-label={original.label}
              >
                <rect className="nodebox" width={n.width} height={n.height} />
                <text
                  className="node-name"
                  x={(n.width || 0) / 2}
                  y="24"
                  textAnchor="middle"
                >
                  {original.label.length > 25
                    ? original.label.slice(0, 23) + "…"
                    : original.label}
                </text>
                <text
                  className="node-kind"
                  x={(n.width || 0) / 2}
                  y="43"
                  textAnchor="middle"
                >
                  {original.kind.length > 23
                    ? original.kind.slice(0, 21) + "…"
                    : original.kind}
                </text>
                {original.child_scope && (
                  <text
                    className="expand"
                    x={(n.width || 0) - 16}
                    y="17"
                    onClick={(e) => {
                      e.stopPropagation();
                      onScope(original.child_scope!);
                    }}
                  >
                    ⊞
                  </text>
                )}
                {n.ports?.map((p) => {
                  const data = original.ports.find((x) => x.id === p.id);
                  if (!data) return null;
                  return (
                    <g
                      key={p.id}
                      transform={`translate(${p.x},${p.y})`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSignal(data.signal_ids);
                      }}
                    >
                      <rect
                        width="8"
                        height="8"
                        className={`port ${data.signal_ids.includes(selected || "") ? "selected" : ""}`}
                      />
                      <text
                        x={data.direction === "output" ? -6 : 14}
                        y="7"
                        textAnchor={
                          data.direction === "output" ? "end" : "start"
                        }
                        className="port-name"
                      >
                        {data.label}
                      </text>
                    </g>
                  );
                })}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
