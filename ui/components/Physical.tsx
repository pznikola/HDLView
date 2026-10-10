import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import {
  automaticSide,
  type Box,
  type Camera,
  drawn,
  dropPlace,
  fill,
  fitCamera,
  type Handle,
  handleAt,
  pinAt,
  pinPoints,
  placePin,
  type Point,
  removePin,
  resized,
  SIDE_LABELS,
  SIDES,
  sidePins,
  toScreen,
  toWorld,
  zoomCamera,
} from "../floorplan";
import { createRenderer, type LayoutRenderer, placements } from "../gl-layout";
import { besideRouting } from "../masks";
import type {
  Check,
  Floorplan,
  LayoutData,
  LayoutShapes,
  MaskData,
  Project,
  Side,
  Snapshot,
} from "../types";

type Drag =
  | { kind: "pan"; from: Point; camera: Camera }
  | { kind: "draw"; from: Point; to: Point }
  | { kind: "resize"; handle: Handle }
  | { kind: "pin"; port: string; at: Point };

function metric(snapshot: Snapshot | undefined, key: string) {
  const value = snapshot?.physical_run?.state.metrics?.[key];
  return typeof value === "number" ? value : undefined;
}

export function Physical({
  project,
  snapshot,
  stale,
  error,
  selectedNet,
  onFloorplan,
  onConfigure,
  onPickNet,
  onPickCell,
  fail,
}: {
  project?: Project;
  snapshot?: Snapshot;
  stale: boolean;
  error: string;
  /** Name of the net of the selected signal. */
  selectedNet?: string;
  onFloorplan: (plan: Floorplan | null) => void;
  onConfigure: () => void;
  onPickNet: (name: string) => void;
  onPickCell: (name: string) => void;
  fail: (error: unknown) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 800, height: 500 });
  const [camera, setCamera] = useState<Camera>();
  const [view, setView] = useState<"plan" | "result">("plan");
  const [layout, setLayout] = useState<LayoutData>();
  const [masks, setMasks] = useState<MaskData>();
  const glCanvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<LayoutRenderer>(undefined);
  const [unsupported, setUnsupported] = useState(false);
  const [checks, setChecks] = useState<Check[]>([]);
  const [shapes, setShapes] = useState<Record<number, LayoutShapes>>({});
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<Drag>();
  const [draft, setDraft] = useState<Floorplan>();
  const [drawing, setDrawing] = useState(false);
  const [cell, setCell] = useState<string>();
  const [marker, setMarker] = useState<Box>();
  const [open, setOpen] = useState<string>();

  const saved = project?.physical?.floorplan ?? undefined;
  const plan = draft ?? saved;
  const cellArea = metric(snapshot, "design__instance__area");
  const override = project?.physical?.overrides.FP_CORE_UTIL;
  const utilization = typeof override === "number" ? override : 30;
  const estimate = cellArea ? automaticSide(cellArea, utilization) : undefined;
  const ports = useMemo(
    () =>
      (snapshot?.design.modules[snapshot.project.top]?.ports ?? []).map(
        (port) => ({
          name: port.name,
          direction: port.direction,
          width: port.bits.length,
        }),
      ),
    [snapshot],
  );
  const layoutId = snapshot?.physical_run?.layout ? snapshot.id : undefined;
  const checksId = snapshot?.physical_run?.checks ? snapshot.id : undefined;
  const masksId =
    snapshot?.physical_run?.gds && snapshot.physical_run.layer_file
      ? snapshot.id
      : undefined;

  useEffect(() => {
    setLayout(undefined);
    setShapes({});
    setCell(undefined);
    setMarker(undefined);
    setView(layoutId ? "result" : "plan");
    setCamera(undefined);
    if (!layoutId) return;
    let active = true;
    api<LayoutData>("layout", { snapshot_id: layoutId })
      .then((data) => {
        if (active) setLayout(data);
      })
      .catch(fail);
    return () => {
      active = false;
    };
  }, [layoutId, fail]);
  useEffect(() => {
    setChecks([]);
    if (!checksId) return;
    let active = true;
    api<{ checks: Check[] }>("checks", { snapshot_id: checksId })
      .then((data) => {
        if (active) setChecks(data.checks);
      })
      .catch(fail);
    return () => {
      active = false;
    };
  }, [checksId, fail]);
  // The GDS as KLayout reads it; layers the layer file hides start hidden.
  useEffect(() => {
    setMasks(undefined);
    if (!masksId) return;
    let active = true;
    api<MaskData>("layout_masks", { snapshot_id: masksId })
      .then((data) => {
        if (!active) return;
        setMasks(data);
        setHidden(
          new Set(
            data.layers
              .filter((layer) => !layer.visible)
              .map((layer) => layer.source),
          ),
        );
      })
      .catch(fail);
    return () => {
      active = false;
    };
  }, [masksId, fail]);
  // A layer's boxes are fetched the first time the layer is shown.
  const wanted = layout?.layers.findIndex(
    (_, index) =>
      !shapes[index] && (layout.wires[index] || layout.power[index]),
  );
  useEffect(() => {
    if (!layoutId || view !== "result" || wanted === undefined || wanted < 0)
      return;
    let active = true;
    api<LayoutShapes>("layout_shapes", { snapshot_id: layoutId, layer: wanted })
      .then((data) => {
        if (active) setShapes((known) => ({ ...known, [wanted]: data }));
      })
      .catch(fail);
    return () => {
      active = false;
    };
  }, [layoutId, view, wanted, fail]);

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (entry)
        setSize({
          width: Math.max(1, Math.floor(entry.contentRect.width)),
          height: Math.max(1, Math.floor(entry.contentRect.height)),
        });
    });
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, []);

  const dbu = layout?.dbu ?? 1000;
  // Without a camera the view follows the outline; a drag fixes it first, so
  // resizing does not move the view under the pointer.
  const world: Box =
    view === "result" && layout
      ? [
          layout.die[0] / dbu,
          layout.die[1] / dbu,
          layout.die[2] / dbu,
          layout.die[3] / dbu,
        ]
      : plan
        ? [0, 0, plan.width_um, plan.height_um]
        : [0, 0, estimate ?? 100, estimate ?? 100];
  const [x0, y0, x1, y1] = world;
  const shown = useMemo(
    () => camera ?? fitCamera([x0, y0, x1, y1], size.width, size.height),
    [camera, x0, y0, x1, y1, size],
  );
  // A vector signal is the nets of its bits.
  const highlighted = useMemo(() => {
    const nets = new Set<number>();
    if (selectedNet)
      layout?.nets.forEach((name, index) => {
        if (name === selectedNet || name.startsWith(selectedNet + "["))
          nets.add(index);
      });
    return nets;
  }, [selectedNet, layout]);

  // The masks are drawn by the GPU on the canvas under the overlay.
  const glShown = view === "result" && !!masks;
  useEffect(() => {
    const element = glCanvas.current;
    if (!element) return;
    let created: LayoutRenderer | undefined;
    try {
      created = createRenderer(element);
    } catch (error) {
      fail(error);
      return;
    }
    if (!created) {
      setUnsupported(true);
      return;
    }
    renderer.current = created;
    return () => {
      created.dispose();
      renderer.current = undefined;
    };
  }, [glShown, fail]);
  const placed = useMemo(
    () => (masks && glShown ? placements(masks, shown, size) : undefined),
    [masks, glShown, shown, size],
  );
  useEffect(() => {
    const drawer = renderer.current;
    if (!drawer || !masks || !placed) return;
    const frame = requestAnimationFrame(() => {
      try {
        drawer.draw(
          masks,
          shown,
          size,
          window.devicePixelRatio || 1,
          hidden,
          placed,
        );
      } catch (error) {
        fail(error);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [masks, placed, shown, size, hidden, fail]);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const ratio = window.devicePixelRatio || 1;
    element.width = size.width * ratio;
    element.height = size.height * ratio;
    const ctx = element.getContext("2d")!;
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, size.width, size.height);
    ctx.font = "11px ui-monospace, monospace";
    const rect = (box: Box): [number, number, number, number] => {
      const [x0, y1] = toScreen(shown, [box[0], box[1]]);
      const [x1, y0] = toScreen(shown, [box[2], box[3]]);
      return [x0, y0, x1 - x0, y1 - y0];
    };
    if (view === "result" && layout) {
      const scaled = (b: readonly (string | number)[], at: number): Box => [
        (b[at] as number) / dbu,
        (b[at + 1] as number) / dbu,
        (b[at + 2] as number) / dbu,
        (b[at + 3] as number) / dbu,
      ];
      // The flow's own wires only tell which ones belong to the selected signal.
      layout.layers.forEach((_, index) => {
        const data = shapes[index];
        if (!data) return;
        if (highlighted.size) {
          ctx.fillStyle = "#ffffff";
          for (const shape of data.wires)
            if (highlighted.has(shape[4])) {
              const [x, y, w, h] = rect(scaled(shape, 0));
              ctx.fillRect(x, y, Math.max(w, 1.5), Math.max(h, 1.5));
            }
        }
      });
      ctx.strokeStyle = "#5f7486";
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(...rect(scaled(layout.core, 0)));
      ctx.setLineDash([]);
      ctx.strokeStyle = "#d8e3ec";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(...rect(scaled(layout.die, 0)));
      const chosen = layout.instances.find((i) => i[0] === cell);
      if (chosen) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.strokeRect(...rect(scaled(chosen, 2)));
      }
      for (const pin of layout.pins) {
        // The masks carry the pins' own metal and labels.
        if (masks || pin[7] !== "SIGNAL") continue;
        const box = scaled(pin, 2);
        const [x, y, w, h] = rect(box);
        ctx.fillStyle = "#eec475";
        ctx.fillRect(x - 1, y - 1, Math.max(w, 3) + 2, Math.max(h, 3) + 2);
        if (layout.pins.length < 80 || shown.scale > 12)
          label(ctx, pin[0], x + w / 2, y + h / 2, size);
      }
      if (marker) {
        const [x, y, w, h] = rect(marker);
        ctx.strokeStyle = "#ff5d5d";
        ctx.lineWidth = 2;
        ctx.strokeRect(x - 6, y - 6, w + 12, h + 12);
      }
      if (masks && shown.scale > 6) {
        ctx.fillStyle = "#ffffff";
        for (const [layer, x, y, text] of masks.labels) {
          if (hidden.has(masks.layers[layer]?.source ?? "")) continue;
          const [px, py] = toScreen(shown, [x / masks.dbu, y / masks.dbu]);
          if (px > 0 && py > 0 && px < size.width && py < size.height)
            ctx.fillText(text, px + 3, py - 3);
        }
      }
    } else {
      if (!plan && estimate) {
        ctx.strokeStyle = "#5f7486";
        ctx.setLineDash([6, 5]);
        ctx.strokeRect(...rect([0, 0, estimate, estimate]));
        ctx.setLineDash([]);
        ctx.fillStyle = "#7692a7";
        const [x, y] = toScreen(shown, [0, estimate]);
        ctx.fillText(
          `Automatic: about ${estimate} × ${estimate} µm at ${utilization} % utilization`,
          x,
          y - 8,
        );
      }
      const outline =
        drag?.kind === "draw" ? drawn(drag.from, drag.to) : plan && { ...plan };
      if (outline) {
        const origin: Point =
          drag?.kind === "draw"
            ? [
                Math.min(drag.from[0], drag.to[0]),
                Math.min(drag.from[1], drag.to[1]),
              ]
            : [0, 0];
        const box: Box = [
          origin[0],
          origin[1],
          origin[0] + outline.width_um,
          origin[1] + outline.height_um,
        ];
        const [x, y, w, h] = rect(box);
        ctx.fillStyle = "#182632";
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = "#d8e3ec";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x, y, w, h);
        ctx.fillStyle = "#9fb4c4";
        ctx.textAlign = "center";
        ctx.fillText(`${outline.width_um} µm`, x + w / 2, y + h + 16);
        ctx.save();
        ctx.translate(x - 8, y + h / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(`${outline.height_um} µm`, 0, 0);
        ctx.restore();
        ctx.textAlign = "left";
        if (drag?.kind !== "draw") {
          ctx.fillStyle = "#d8e3ec";
          for (const [hx, hy] of [
            [outline.width_um, outline.height_um / 2],
            [outline.width_um / 2, outline.height_um],
            [outline.width_um, outline.height_um],
          ] as Point[]) {
            const [px, py] = toScreen(shown, [hx, hy]);
            ctx.fillRect(px - 4, py - 4, 8, 8);
          }
          for (const side of SIDES) {
            const names = sidePins(outline, side);
            pinPoints(outline, side).forEach((point, index) => {
              const name = names[index]!;
              const [px, py] =
                drag?.kind === "pin" && drag.port === name
                  ? toScreen(shown, drag.at)
                  : toScreen(shown, point);
              ctx.fillStyle = "#eec475";
              ctx.fillRect(px - 5, py - 5, 10, 10);
              const width = ports.find((port) => port.name === name)?.width;
              label(
                ctx,
                width && width > 1 ? `${name}[${width}]` : name,
                px,
                py,
                size,
                side,
              );
            });
          }
        }
      }
    }
  }, [
    size,
    shown,
    view,
    layout,
    shapes,
    hidden,
    plan,
    estimate,
    utilization,
    drag,
    ports,
    cell,
    marker,
    highlighted,
    masks,
    dbu,
  ]);

  const at = (event: { clientX: number; clientY: number }): Point => {
    const bounds = canvas.current!.getBoundingClientRect();
    return [event.clientX - bounds.left, event.clientY - bounds.top];
  };
  const commit = (next: Floorplan | null) => {
    setDraft(undefined);
    onFloorplan(next);
  };
  function pick(point: Point) {
    if (!layout) return;
    const [x, y] = [point[0] * dbu, point[1] * dbu];
    const inside = (b: readonly (string | number)[], o: number) =>
      x >= (b[o] as number) &&
      x <= (b[o + 2] as number) &&
      y >= (b[o + 1] as number) &&
      y <= (b[o + 3] as number);
    for (let index = layout.layers.length - 1; index >= 0; index--) {
      const data = shapes[index];
      if (!data) continue;
      const wire = data.wires.find((shape) => inside(shape, 0));
      const net = wire && layout.nets[wire[4]];
      if (net) {
        setCell(undefined);
        onPickNet(net);
        return;
      }
    }
    const instance = layout.instances.find((candidate) => inside(candidate, 2));
    setCell(instance?.[0]);
    if (instance) onPickCell(instance[0]);
  }
  const toggle = (name: string) =>
    setHidden((known) => {
      const next = new Set(known);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  const selected = layout?.instances.find((instance) => instance[0] === cell);
  const filled = cellArea && plan ? fill(cellArea, plan) : undefined;
  const density = project?.physical?.overrides.PL_TARGET_DENSITY_PCT;
  const sideOf = (port: string) =>
    plan?.pins.find((pin) => pin.port === port)?.side ?? "";

  return (
    <div className="physical-pane">
      <div className="physical-tools">
        <button
          aria-pressed={view === "plan"}
          onClick={() => {
            setView("plan");
            setCamera(undefined);
          }}
        >
          Floorplan
        </button>
        <button
          aria-pressed={view === "result"}
          disabled={!layout}
          title={
            layout ? undefined : "Run a Post-layout build to see the layout"
          }
          onClick={() => {
            setView("result");
            setCamera(undefined);
          }}
        >
          Layout
        </button>
        <button onClick={() => setCamera(undefined)}>Fit</button>
        {view === "plan" && project?.physical && (
          <>
            <button aria-pressed={drawing} onClick={() => setDrawing(!drawing)}>
              Draw floorplan
            </button>
            {plan ? (
              <>
                <label>
                  Width µm
                  <input
                    aria-label="Floorplan width"
                    type="number"
                    min="0.1"
                    step="0.1"
                    value={plan.width_um}
                    onChange={(event) => {
                      const width_um = Number(event.target.value);
                      if (width_um > 0) commit({ ...plan, width_um });
                    }}
                  />
                </label>
                <label>
                  Height µm
                  <input
                    aria-label="Floorplan height"
                    type="number"
                    min="0.1"
                    step="0.1"
                    value={plan.height_um}
                    onChange={(event) => {
                      const height_um = Number(event.target.value);
                      if (height_um > 0) commit({ ...plan, height_um });
                    }}
                  />
                </label>
                <button onClick={() => commit(null)}>Automatic</button>
              </>
            ) : (
              <>
                <span>Automatic size</span>
                {estimate && (
                  <button
                    onClick={() =>
                      commit({
                        width_um: estimate,
                        height_um: estimate,
                        pins: [],
                      })
                    }
                  >
                    Use as fixed floorplan
                  </button>
                )}
              </>
            )}
            {filled !== undefined && (
              <span
                className={
                  filled > 100
                    ? "physical-over"
                    : filled > (typeof density === "number" ? density : 40)
                      ? "physical-dense"
                      : undefined
                }
              >
                Cells fill {filled.toFixed(0)} % of the rectangle
              </span>
            )}
            {!cellArea && (
              <span>Build Mapped gates to see how full the rectangle is</span>
            )}
          </>
        )}
        {view === "result" && stale && (
          <span className="physical-dense">
            Settings or sources changed · this layout is from the last build
          </span>
        )}
        {view === "result" && selected && (
          <span>
            {selected[0]} · {layout?.masters[selected[1]]?.name}
          </span>
        )}
      </div>
      {error.startsWith("The design cannot fit") && view === "plan" && (
        <p className="physical-error" role="alert">
          {error}
        </p>
      )}
      <div className="physical-body">
        <div className="physical-canvas" ref={host}>
          {view === "plan" && !project?.physical ? (
            <div className="physical-empty">
              <p>A floorplan needs the Physical Design settings.</p>
              <button onClick={onConfigure}>Configure Physical Design…</button>
            </div>
          ) : (
            <>
              {glShown && !unsupported && (
                <canvas
                  className="physical-gl"
                  ref={glCanvas}
                  aria-hidden="true"
                  style={{ width: size.width, height: size.height }}
                />
              )}
              {glShown && unsupported && (
                <div className="physical-empty">
                  <p>
                    The layout view needs WebGL2, which this window cannot
                    provide.
                  </p>
                </div>
              )}
              <canvas
                ref={canvas}
                aria-label={view === "plan" ? "Floorplan" : "Layout"}
                style={{
                  width: size.width,
                  height: size.height,
                  cursor: drawing ? "crosshair" : undefined,
                }}
                onWheel={(event) =>
                  setCamera(
                    zoomCamera(
                      shown,
                      event.deltaY < 0 ? 1.15 : 1 / 1.15,
                      at(event),
                    ),
                  )
                }
                onDragOver={(event) => {
                  if (view === "plan" && plan) event.preventDefault();
                }}
                onDrop={(event) => {
                  const port = event.dataTransfer.getData("text/plain");
                  if (!plan || !ports.some((known) => known.name === port))
                    return;
                  event.preventDefault();
                  const place = dropPlace(
                    plan,
                    toWorld(shown, at(event)),
                    port,
                  );
                  commit(placePin(plan, port, place.side, place.index));
                }}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  const point = toWorld(shown, at(event));
                  const tolerance = 7 / shown.scale;
                  if (view === "plan" && event.button === 0) {
                    if (drawing) {
                      setDrag({ kind: "draw", from: point, to: point });
                      return;
                    }
                    const port = plan && pinAt(plan, point, tolerance);
                    if (port) {
                      setCamera(shown);
                      setDrag({ kind: "pin", port, at: point });
                      return;
                    }
                    const handle = plan && handleAt(plan, point, tolerance);
                    if (plan && handle) {
                      setCamera(shown);
                      setDraft(plan);
                      setDrag({ kind: "resize", handle });
                      return;
                    }
                  }
                  setDrag({ kind: "pan", from: at(event), camera: shown });
                }}
                onPointerMove={(event) => {
                  if (!drag) return;
                  const point = toWorld(shown, at(event));
                  if (drag.kind === "pan") {
                    const [x, y] = at(event);
                    setCamera({
                      ...drag.camera,
                      x: drag.camera.x - (x - drag.from[0]) / drag.camera.scale,
                      y: drag.camera.y + (y - drag.from[1]) / drag.camera.scale,
                    });
                  } else if (drag.kind === "draw")
                    setDrag({ ...drag, to: point });
                  else if (drag.kind === "pin") setDrag({ ...drag, at: point });
                  else if (plan) setDraft(resized(plan, drag.handle, point));
                }}
                onPointerUp={(event) => {
                  const point = toWorld(shown, at(event));
                  const ended = drag;
                  setDrag(undefined);
                  if (!ended) return;
                  if (ended.kind === "pan") {
                    const [x, y] = at(event);
                    const moved =
                      Math.abs(x - ended.from[0]) + Math.abs(y - ended.from[1]);
                    if (moved < 4 && view === "result") pick(point);
                  } else if (ended.kind === "draw") {
                    const next = drawn(ended.from, ended.to);
                    setDrawing(false);
                    if (next) {
                      setCamera(undefined);
                      commit({ ...next, pins: saved?.pins ?? [] });
                    }
                  } else if (ended.kind === "resize") {
                    if (draft) commit(draft);
                  } else if (plan) {
                    // A pin dropped well away from the outline is taken off it.
                    const away = 40 / shown.scale;
                    const outside =
                      point[0] < -away ||
                      point[1] < -away ||
                      point[0] > plan.width_um + away ||
                      point[1] > plan.height_um + away;
                    const place = dropPlace(plan, point, ended.port);
                    commit(
                      outside
                        ? removePin(plan, ended.port)
                        : placePin(plan, ended.port, place.side, place.index),
                    );
                  }
                }}
              />
            </>
          )}
        </div>
        <aside className="physical-side">
          {view === "plan" ? (
            <>
              <h3>Ports</h3>
              {!ports.length && (
                <p className="muted">Build the design to list its ports.</p>
              )}
              {!!ports.length && !plan && (
                <p className="muted">
                  Pins can be placed on a fixed floorplan.
                </p>
              )}
              {plan && !!ports.length && (
                <p className="muted">
                  Drag a port onto a side, or choose the side. Ports without a
                  side go to the sides with the fewest pins; the flow sets the
                  final positions.
                </p>
              )}
              <ul>
                {ports.map((port) => (
                  <li
                    key={port.name}
                    draggable={!!plan}
                    onDragStart={(event) =>
                      event.dataTransfer.setData("text/plain", port.name)
                    }
                  >
                    <span title={port.direction}>
                      {port.name}
                      {port.width > 1 ? `[${port.width}]` : ""}
                    </span>
                    <select
                      aria-label={`Side of ${port.name}`}
                      disabled={!plan}
                      value={sideOf(port.name)}
                      onChange={(event) => {
                        if (!plan) return;
                        const side = event.target.value as Side | "";
                        commit(
                          side
                            ? placePin(
                                plan,
                                port.name,
                                side,
                                sidePins(plan, side).length,
                              )
                            : removePin(plan, port.name),
                        );
                      }}
                    >
                      <option value="">Any side</option>
                      {SIDES.map((side) => (
                        <option key={side} value={side}>
                          {SIDE_LABELS[side]}
                        </option>
                      ))}
                    </select>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <h3>Layers</h3>
              {masks ? (
                <>
                  <div className="physical-layer-tools">
                    <button onClick={() => setHidden(new Set())}>
                      Show all
                    </button>
                    <button
                      onClick={() =>
                        setHidden(
                          new Set(masks.layers.map((layer) => layer.source)),
                        )
                      }
                    >
                      Hide all
                    </button>
                    <button
                      title="Metal and via layers"
                      onClick={() =>
                        setHidden(
                          new Set(
                            besideRouting(masks.layers, [
                              ...(layout?.layers ?? []),
                              ...(layout?.cuts ?? []),
                            ]),
                          ),
                        )
                      }
                    >
                      Routing only
                    </button>
                  </div>
                  <ul>
                    {masks.layers.map((layer) => (
                      <li key={layer.source}>
                        <label title={`GDS ${layer.source}`}>
                          <input
                            type="checkbox"
                            checked={!hidden.has(layer.source)}
                            onChange={() => toggle(layer.source)}
                          />
                          <i
                            style={{
                              background: layer.pattern.some((row) =>
                                row.includes("*"),
                              )
                                ? layer.fill
                                : "transparent",
                              border: `1px solid ${layer.frame}`,
                            }}
                          />
                          {layer.name}
                        </label>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="muted">No mask view for this build.</p>
              )}
              <h3>Checks</h3>
              <ul className="physical-checks">
                {checks.map((check) => (
                  <li key={check.id}>
                    <button
                      className={`physical-${check.status}`}
                      aria-expanded={open === check.id}
                      onClick={() =>
                        setOpen(open === check.id ? undefined : check.id)
                      }
                    >
                      <span>{check.title}</span>
                      <span>
                        {check.status === "clean"
                          ? "clean"
                          : check.status === "not_run"
                            ? "not run"
                            : check.count}
                      </span>
                    </button>
                    {open === check.id && (
                      <div>
                        {check.summary && (
                          <p className="muted">
                            Layout {check.summary.devices[0]} devices,{" "}
                            {check.summary.nets[0]} nets · netlist{" "}
                            {check.summary.devices[1]} devices,{" "}
                            {check.summary.nets[1]} nets
                          </p>
                        )}
                        {check.rules?.map((rule) => (
                          <details key={rule.rule}>
                            <summary title={rule.description}>
                              {rule.rule} · {rule.count}
                            </summary>
                            <p className="muted">{rule.description}</p>
                            {rule.boxes.map((box, index) => (
                              <button
                                key={index}
                                onClick={() => {
                                  setMarker(box);
                                  const pad = 5;
                                  setCamera(
                                    fitCamera(
                                      [
                                        box[0] - pad,
                                        box[1] - pad,
                                        box[2] + pad,
                                        box[3] + pad,
                                      ],
                                      size.width,
                                      size.height,
                                    ),
                                  );
                                }}
                              >
                                {box[0].toFixed(2)}, {box[1].toFixed(2)}
                              </button>
                            ))}
                          </details>
                        ))}
                        {check.mismatches?.map((mismatch, index) => (
                          <p key={index}>
                            {mismatch.kind} in {mismatch.cell}: layout{" "}
                            {mismatch.layout.join(", ") || "none"} · netlist{" "}
                            {mismatch.netlist.join(", ") || "none"}
                          </p>
                        ))}
                        {check.status === "clean" && !check.summary && (
                          <p className="muted">No violations.</p>
                        )}
                        {check.status === "not_run" && (
                          <p className="muted">
                            This check did not run in the flow.
                          </p>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

/** A name beside a point, kept inside the canvas; a pin's name is drawn inside the outline. */
function label(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: { width: number; height: number },
  side?: Side,
) {
  const width = ctx.measureText(text).width;
  const left =
    side === "north" || side === "south"
      ? x - width / 2
      : side === "east" || x + 9 + width > size.width
        ? x - 9 - width
        : x + 9;
  const top = side === "north" ? y + 18 : side === "south" ? y - 10 : y + 4;
  ctx.fillStyle = "#d8e3ec";
  ctx.fillText(text, left, Math.min(size.height - 4, Math.max(12, top)));
}
