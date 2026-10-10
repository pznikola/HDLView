import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { position, formatValue } from "../selection";
import {
  RADIXES,
  UNITS,
  formatFrequency,
  formatTime,
  moveTrace,
  pan,
  pathKey,
  readView,
  rulerTicks,
  rulerUnit,
  writeView,
  zoomAt,
} from "../wave-layout";
import type { Radix, Range, Trace, Unit } from "../wave-layout";
import type { Run, WaveInfo, WaveRow } from "../types";
const ROW = 30,
  RULER = 22,
  SNAP = 5;
const COLORS = {
  Teal: "#65d4bd",
  Yellow: "#e6d36b",
  Blue: "#7fb4f2",
  Pink: "#f08fc0",
  Green: "#9bd66b",
  White: "#e6edf2",
};
const CURSOR = "#eec475",
  OTHER = "#8fb7ff";
/** One drawn row: a divider, a signal, or one bit of an expanded signal. */
interface Row {
  trace: number;
  id?: number;
  bit?: number;
  /** Place of the bit in the value as printed, leftmost first. */
  offset?: number;
}
function timeAt(x: number, range: Range, plot: number): bigint {
  const inside = Math.max(0, Math.min(plot, x));
  return (
    range[0] +
    (BigInt(Math.round(inside * 1024)) * (range[1] - range[0])) /
      BigInt(Math.round(plot * 1024))
  );
}
function prepare(canvas: HTMLCanvasElement, width: number, height: number) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = width + "px";
  canvas.style.height = height + "px";
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  ctx.font = "11px ui-monospace, monospace";
  ctx.fillStyle = "#111b26";
  ctx.fillRect(0, 0, width, height);
  return ctx;
}
export function Waveform({
  run,
  active,
  info,
  storage,
  traces,
  selected,
  onSelect,
  onTraces,
  onCursor,
}: {
  run: Run;
  active: boolean;
  info: WaveInfo;
  /** Where the view of this project, stage and testbench is kept between runs. */
  storage: string;
  traces: Trace[];
  selected?: number;
  onSelect: (id: number) => void;
  onTraces: (update: (traces: Trace[]) => Trace[]) => void;
  onCursor: (time: string) => void;
}) {
  const end = BigInt(info.end_time) || 1n;
  const [saved] = useState(() => readView(storage));
  const [range, setRange] = useState<Range>(() => {
    const from = BigInt(saved.range?.[0] ?? 0),
      to = BigInt(saved.range?.[1] ?? 0);
    return from < to && to <= end ? [from, to] : [0n, end];
  });
  const within = (time?: string) =>
    time !== undefined && BigInt(time) <= end ? BigInt(time) : undefined;
  const [cursor, setCursor] = useState(() => within(saved.cursor) ?? 0n);
  const [other, setOther] = useState(() => within(saved.other) ?? 0n);
  /** Cursor B was moved last; the edge buttons and keys move that cursor. */
  const [onB, setOnB] = useState(false);
  const [unit, setUnit] = useState(saved.unit);
  const [labelWidth, setLabelWidth] = useState(saved.labelWidth);
  const [fullPaths, setFullPaths] = useState(saved.fullPaths);
  const [radix, setRadix] = useState(saved.radix);
  const [scroll, setScroll] = useState(0);
  const [rows, setRows] = useState<WaveRow[]>([]);
  const [values, setValues] = useState(new Map<number, string>());
  const [error, setError] = useState("");
  const [viewport, setViewport] = useState({ width: 1000, height: 238 });
  /** The bit row clicked last; an edge search follows that bit. */
  const [picked, setPicked] = useState<Row>();
  const [band, setBand] = useState<[number, number]>();
  const [drop, setDrop] = useState<number>();
  const [menu, setMenu] = useState<{ x: number; y: number; trace: number }>();
  const [renaming, setRenaming] = useState<number>();
  const body = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const ruler = useRef<HTMLCanvasElement>(null);
  const gesture = useRef<{
    x: number;
    y: number;
    range: Range;
    button: number;
    moved: boolean;
  }>(undefined);
  const width = viewport.width;
  const label = Math.max(120, Math.min(labelWidth, width - 120));
  const plot = Math.max(1, width - label);
  const byPath = useMemo(
    () => new Map(info.variables.map((v) => [pathKey(v.path), v])),
    [info.variables],
  );
  const displayed = useMemo(
    () =>
      traces.flatMap((trace, index): Row[] => {
        if ("divider" in trace) return [{ trace: index }];
        const v = byPath.get(pathKey(trace.path));
        const base = { trace: index, id: v?.id };
        if (!v || !trace.expanded) return [base];
        const left = v.index?.[0] ?? v.width - 1;
        const rising = v.index && v.index[0] < v.index[1];
        return [
          base,
          ...Array.from({ length: Math.min(v.width, 256) }, (_, offset) => ({
            ...base,
            bit: left + (rising ? offset : -offset),
            offset,
          })),
        ];
      }),
    [traces, byPath],
  );
  const first = Math.floor(scroll / ROW);
  const count = Math.max(
    0,
    Math.min(Math.ceil(viewport.height / ROW) + 1, displayed.length - first),
  );
  // Stable window inputs keep cursor/selection renders from repeating IPC queries.
  const shown = useMemo(
    () => displayed.slice(first, first + count),
    [displayed, first, count],
  );
  const ids = useMemo(
    () => [
      ...new Set(
        shown.flatMap((row) => (row.id === undefined ? [] : [row.id])),
      ),
    ],
    [shown],
  );
  const query = useMemo(
    () => ({
      ids,
      start: range[0].toString(),
      end: range[1].toString(),
      pixels: Math.round(plot),
    }),
    [ids, range, plot],
  );
  const current = traces.findIndex(
    (t) => "path" in t && byPath.get(pathKey(t.path))?.id === selected,
  );
  const shownUnit = rulerUnit(range, info.timescale, unit);
  const ticks = useMemo(() => rulerTicks(range, plot), [range, plot]);
  const text = (time: bigint) => formatTime(time, info.timescale, unit);

  useEffect(() => {
    if (!active || selected === undefined || !container.current) return;
    const index = displayed.findIndex((row) => row.id === selected);
    if (index < 0) return;
    const element = container.current;
    const top = index * ROW;
    if (
      top < element.scrollTop ||
      top + ROW > element.scrollTop + element.clientHeight
    )
      element.scrollTop = top;
  }, [active, selected, displayed]);
  useEffect(() => {
    const ob = new ResizeObserver(([entry]) => {
      if (entry)
        setViewport({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
    });
    if (container.current) ob.observe(container.current);
    return () => ob.disconnect();
  }, []);
  // A wheel gesture changes the window many times; only the newest is asked for
  // once the answer to the previous one is back.
  const fetching = useRef<{ wanted?: typeof query; busy: boolean }>({
    busy: false,
  });
  useEffect(() => {
    if (!active || !query.ids.length) return;
    const state = fetching.current;
    state.wanted = query;
    if (state.busy) return;
    const send = () => {
      const next = state.wanted;
      if (!next) return;
      state.wanted = undefined;
      state.busy = true;
      api<WaveRow[]>("wave_window", { run_id: run.id, ...next })
        .then((data) => {
          setRows(data);
          setError("");
        })
        .catch((e) => setError(String(e)))
        .finally(() => {
          state.busy = false;
          send();
        });
    };
    send();
  }, [active, run.id, query]);
  useEffect(() => {
    if (!active || !ids.length) return;
    let live = true;
    // A dragged cursor passes many times; ask only for the one it rests on.
    const timer = setTimeout(() => {
      api<WaveRow[]>("wave_values", {
        run_id: run.id,
        ids,
        start: cursor.toString(),
      })
        .then((data) => {
          if (live)
            setValues(
              new Map(
                data.map((r) => [r.id, r.transitions.at(-1)?.value ?? ""]),
              ),
            );
        })
        .catch((e) => {
          if (live) setError(String(e));
        });
    }, 30);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [active, run.id, ids, cursor]);
  // A cursor kept from the previous run also sets the values shown on the schematic.
  const announced = useRef(false);
  useEffect(() => {
    if (announced.current) return;
    announced.current = true;
    if (cursor) onCursor(cursor.toString());
  }, [cursor, onCursor]);
  useEffect(() => {
    const timer = setTimeout(
      () =>
        writeView(storage, {
          range: [range[0].toString(), range[1].toString()],
          cursor: cursor.toString(),
          other: other.toString(),
          unit,
          labelWidth,
          fullPaths,
          radix,
        }),
      300,
    );
    return () => clearTimeout(timer);
  }, [storage, range, cursor, other, unit, labelWidth, fullPaths, radix]);
  useEffect(() => {
    const element = body.current;
    if (!element) return;
    const wheel = (e: WheelEvent) => {
      const sideways = e.shiftKey
        ? e.deltaX || e.deltaY
        : Math.abs(e.deltaX) > Math.abs(e.deltaY)
          ? e.deltaX
          : 0;
      if (!e.ctrlKey && !sideways) return;
      e.preventDefault();
      const x = e.clientX - element.getBoundingClientRect().left - label;
      setRange((r) =>
        e.ctrlKey
          ? zoomAt(r, timeAt(x, r, plot), Math.exp(e.deltaY * 0.003), end)
          : pan(
              r,
              (BigInt(Math.round(sideways * 1024)) * (r[1] - r[0])) /
                BigInt(Math.round(plot * 1024)),
              end,
            ),
      );
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [label, plot, end]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (!(e.target as HTMLElement).closest?.(".wave-menu"))
        setMenu(undefined);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menu]);
  useEffect(() => {
    const c = ruler.current;
    if (!c) return;
    const ctx = prepare(c, width, RULER);
    ctx.fillStyle = "#182632";
    ctx.fillRect(0, 0, width, RULER);
    ctx.save();
    ctx.beginPath();
    ctx.rect(label, 0, plot, RULER);
    ctx.clip();
    ctx.strokeStyle = "#4a6072";
    ctx.fillStyle = "#9fb4c4";
    for (const time of ticks) {
      const x = label + position(time, range[0], range[1], plot);
      ctx.beginPath();
      ctx.moveTo(x, RULER - 6);
      ctx.lineTo(x, RULER);
      ctx.stroke();
      ctx.fillText(formatTime(time, info.timescale, shownUnit), x + 4, 13);
    }
    const flag = (time: bigint, color: string, name: string) => {
      const x = label + position(time, range[0], range[1], plot);
      ctx.fillStyle = color;
      ctx.fillRect(x - 0.5, 0, 1, RULER);
      const w = ctx.measureText(name).width + 6;
      ctx.fillRect(x, 0, w, 12);
      ctx.fillStyle = "#111b26";
      ctx.fillText(name, x + 3, 10);
    };
    // The cursor that the edge buttons move lies on top.
    if (onB) flag(cursor, CURSOR, "A");
    flag(other, OTHER, "B");
    if (!onB) flag(cursor, CURSOR, "A");
    ctx.restore();
  }, [
    onB,
    width,
    label,
    plot,
    ticks,
    range,
    cursor,
    other,
    shownUnit,
    info.timescale,
  ]);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const height = count * ROW;
    const ctx = prepare(c, width, height);
    ctx.save();
    ctx.beginPath();
    ctx.rect(label, 0, plot, height);
    ctx.clip();
    const at = (time: bigint) =>
      label + position(time, range[0], range[1], plot);
    for (const [r, row] of shown.entries()) {
      const y = r * ROW;
      if (row.id === undefined || row.id === selected) {
        ctx.fillStyle = row.id === undefined ? "#172531" : "#1c3c46";
        ctx.fillRect(label, y, plot, ROW);
      }
      ctx.strokeStyle = "#263646";
      ctx.beginPath();
      ctx.moveTo(label, y + ROW);
      ctx.lineTo(width, y + ROW);
      ctx.stroke();
    }
    ctx.strokeStyle = "#1f2e3c";
    for (const time of ticks) {
      ctx.beginPath();
      ctx.moveTo(at(time), 0);
      ctx.lineTo(at(time), height);
      ctx.stroke();
    }
    for (const [r, row] of shown.entries()) {
      if (row.id === undefined) continue;
      const variable = info.variables[row.id];
      const trace = traces[row.trace];
      if (!trace) continue;
      const y = r * ROW;
      const changes = rows.find((x) => x.id === row.id)?.transitions || [];
      for (const [i, change] of changes.entries()) {
        const busy = change.value.startsWith("activity:");
        const settled = busy ? change.value.slice(9) : change.value;
        const value =
          row.offset === undefined ? settled : settled[row.offset] || "x";
        const x = at(BigInt(change.time)),
          next = changes[i + 1];
        const right = next ? at(BigInt(next.time)) : width;
        const x0 = Math.max(label, x);
        ctx.strokeStyle = value.includes("x")
          ? "#e49b77"
          : value.includes("z")
            ? "#bfa4f4"
            : ("path" in trace && trace.color) || COLORS.Teal;
        ctx.fillStyle = ctx.strokeStyle;
        // Several changes fell into this pixel; only the last value is known here.
        if (busy) ctx.fillRect(x - 1, y + 6, 2, 18);
        if (
          (variable?.width === 1 || row.bit !== undefined) &&
          /^[01]$/.test(value)
        ) {
          const yy = y + (value === "1" ? 7 : 23);
          ctx.beginPath();
          ctx.moveTo(x, yy);
          ctx.lineTo(right, yy);
          ctx.lineTo(right, y + (value === "1" ? 23 : 7));
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.moveTo(x, y + 15);
          ctx.lineTo(x + 4, y + 6);
          ctx.lineTo(right - 4, y + 6);
          ctx.lineTo(right, y + 15);
          ctx.lineTo(right - 4, y + 24);
          ctx.lineTo(x + 4, y + 24);
          ctx.closePath();
          ctx.stroke();
          if (right - x0 > 30)
            ctx.fillText(
              formatValue(
                value,
                row.bit === undefined && "path" in trace
                  ? (trace.radix ?? radix)
                  : "bin",
              ),
              x0 + 7,
              y + 19,
            );
        }
      }
    }
    const line = (time: bigint, color: string, dash: number[]) => {
      ctx.strokeStyle = color;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(at(time), 0);
      ctx.lineTo(at(time), height);
      ctx.stroke();
    };
    line(other, OTHER, [5, 3]);
    line(cursor, CURSOR, []);
    if (band) {
      ctx.fillStyle = "#eec47533";
      ctx.fillRect(
        label + Math.min(...band),
        0,
        Math.abs(band[1] - band[0]),
        height,
      );
    }
    ctx.restore();
  }, [
    rows,
    width,
    label,
    plot,
    count,
    selected,
    cursor,
    other,
    band,
    ticks,
    range,
    radix,
    shown,
    traces,
    info.variables,
  ]);

  function moveCursor(time: bigint, reveal = false) {
    setCursor(time);
    onCursor(time.toString());
    if (reveal && (time < range[0] || time > range[1]))
      setRange((r) => pan(r, time - (r[0] + r[1]) / 2n, end));
  }
  function zoom(factor: number) {
    const inside = cursor >= range[0] && cursor <= range[1];
    setRange(
      zoomAt(range, inside ? cursor : (range[0] + range[1]) / 2n, factor, end),
    );
  }
  async function edge(direction: "next" | "previous") {
    if (selected === undefined) return;
    try {
      const time = await api<string | null>("wave_edge", {
        run_id: run.id,
        id: selected,
        time: (onB ? other : cursor).toString(),
        direction,
        bit: picked?.id === selected ? picked.offset : undefined,
      });
      if (time === null) return;
      const found = BigInt(time);
      if (!onB) moveCursor(found, true);
      else {
        setOther(found);
        if (found < range[0] || found > range[1])
          setRange((r) => pan(r, found - (r[0] + r[1]) / 2n, end));
      }
    } catch (e) {
      setError(String(e));
    }
  }
  function pick(row?: Row) {
    if (row?.id === undefined) return;
    setPicked(row);
    onSelect(row.id);
  }
  const edit = (index: number, change: Partial<Trace>) =>
    onTraces((list) =>
      list.map((t, i) => (i === index ? { ...t, ...change } : t)),
    );
  const remove = (index: number) =>
    onTraces((list) => list.filter((_, i) => i !== index));
  /** A click lands on a change of its row when one is within a few pixels. */
  function clicked(row: Row | undefined, x: number): bigint {
    let best = timeAt(x, range, plot),
      distance = SNAP;
    for (const change of rows.find((r) => r.id === row?.id)?.transitions ??
      []) {
      const d = Math.abs(
        position(BigInt(change.time), range[0], range[1], plot) - x,
      );
      if (d <= distance) [best, distance] = [BigInt(change.time), d];
    }
    return best;
  }
  function keys(e: React.KeyboardEvent) {
    if (
      e.ctrlKey ||
      e.metaKey ||
      (e.target as HTMLElement).closest("input,select,.wave-menu")
    )
      return;
    const span = range[1] - range[0];
    const signals = displayed.filter(
      (row) => row.id !== undefined && row.bit === undefined,
    );
    const place = signals.findIndex((row) => row.id === selected);
    const step = e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 1;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      if (e.shiftKey) setRange(pan(range, (BigInt(step) * span) / 10n, end));
      else void edge(step < 0 ? "previous" : "next");
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      if (e.altKey) {
        if (current >= 0)
          onTraces((list) =>
            moveTrace(list, current, current + (step < 0 ? -1 : 2)),
          );
      } else pick(signals[place < 0 ? 0 : place + step]);
    } else if (e.key === "+" || e.key === "=") zoom(0.5);
    else if (e.key === "-") zoom(2);
    else if (e.key === "f" || e.key === "F") setRange([0n, end]);
    else if (e.key === "b" || e.key === "B") setOther(cursor);
    else if (e.key === "Delete" && current >= 0) remove(current);
    else return;
    e.preventDefault();
  }
  const menuTrace = menu && traces[menu.trace];
  return (
    <section className="wave-panel" id="waveform-pane" onKeyDown={keys}>
      <div className="wave-toolbar">
        <span className="muted">
          {info.timescale
            ? `${formatTime(1n, info.timescale, "auto")} / tick`
            : "no timescale"}
        </span>
        <button onClick={() => zoom(0.5)}>Zoom in</button>
        <button onClick={() => zoom(2)}>Zoom out</button>
        <button onClick={() => setRange([0n, end])}>Full trace</button>
        <button
          disabled={selected === undefined}
          onClick={() => void edge("previous")}
        >
          Previous edge
        </button>
        <button
          disabled={selected === undefined}
          onClick={() => void edge("next")}
        >
          Next edge
        </button>
        <button
          title="Put cursor B where cursor A is (key B); then move A to measure"
          onClick={() => setOther(cursor)}
        >
          Set B
        </button>
        <select
          aria-label="Radix"
          value={radix}
          onChange={(e) => setRadix(e.target.value as Radix)}
        >
          {Object.entries(RADIXES).map(([value, name]) => (
            <option key={value} value={value}>
              {name}
            </option>
          ))}
        </select>
        <select
          aria-label="Time unit"
          value={unit}
          onChange={(e) => setUnit(e.target.value as Unit)}
        >
          <option value="auto">Auto unit</option>
          {Object.keys(UNITS).map((name) => (
            <option key={name}>{name}</option>
          ))}
          <option value="ticks">Ticks</option>
        </select>
        <label>
          <input
            type="checkbox"
            checked={fullPaths}
            onChange={(e) => setFullPaths(e.target.checked)}
          />
          Full paths
        </label>
        <button
          className="cursor-label"
          aria-pressed={!onB}
          title="Previous edge and Next edge move cursor A"
          onClick={() => setOnB(false)}
        >
          A {text(cursor)}
        </button>
        <button
          className="delta-label"
          aria-pressed={onB}
          title="Previous edge and Next edge move cursor B"
          onClick={() => setOnB(true)}
        >
          B {text(other)}
        </button>
        <span className="delta">
          Δ {text(cursor > other ? cursor - other : other - cursor)}
          {info.timescale && cursor !== other
            ? ` · ${formatFrequency(cursor > other ? cursor - other : other - cursor, info.timescale)}`
            : ""}
        </span>
        <span>
          {text(range[0])} — {text(range[1])}
        </span>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="wave-body" ref={body}>
        <canvas
          ref={ruler}
          aria-label="Time ruler"
          onPointerDown={(e) => {
            const x =
              e.clientX - e.currentTarget.getBoundingClientRect().left - label;
            if (x < 0 || e.button !== 0) return;
            // Pressing on the ruler takes cursor A, or B with Shift or on B's flag,
            // and the cursor then follows the pointer.
            const held = (time: bigint) => {
              const d = x - position(time, range[0], range[1], plot);
              return d >= -4 && d <= 14;
            };
            const second = e.shiftKey || (held(other) && !held(cursor));
            e.currentTarget.setPointerCapture(e.pointerId);
            gesture.current = {
              x,
              y: second ? 1 : 0,
              range,
              button: -3,
              moved: true,
            };
            setOnB(second);
            (second ? setOther : setCursor)(timeAt(x, range, plot));
          }}
          onPointerMove={(e) => {
            const g = gesture.current;
            if (g?.button !== -3) return;
            const x =
              e.clientX - e.currentTarget.getBoundingClientRect().left - label;
            (g.y ? setOther : setCursor)(timeAt(x, range, plot));
          }}
          onPointerUp={() => {
            const g = gesture.current;
            gesture.current = undefined;
            // The schematic values follow once the cursor rests.
            if (g?.button === -3 && !g.y) onCursor(cursor.toString());
          }}
        />
        <div
          className="wave-scroll"
          ref={container}
          tabIndex={0}
          onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
        >
          <div
            style={{
              height: Math.max(displayed.length * ROW, 160),
              position: "relative",
            }}
          >
            {!traces.length && (
              <p className="empty-wave">
                Select a schematic signal or add signals from the list.
              </p>
            )}
            <div
              style={{
                position: "absolute",
                top: first * ROW,
                left: 0,
                width: "100%",
              }}
            >
              <canvas
                ref={canvas}
                aria-label="Waveform traces"
                onMouseDown={(e) => {
                  if (e.button === 1) e.preventDefault();
                }}
                onPointerDown={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const x = e.clientX - rect.left - label;
                  if (x < 0 || e.button > 1) return;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  gesture.current = {
                    x,
                    y: e.clientY - rect.top,
                    range,
                    button: e.button,
                    moved: false,
                  };
                }}
                onPointerMove={(e) => {
                  const g = gesture.current;
                  if (!g) return;
                  const x =
                    e.clientX -
                    e.currentTarget.getBoundingClientRect().left -
                    label;
                  if (Math.abs(x - g.x) > 4) g.moved = true;
                  if (!g.moved) return;
                  if (g.button === 0) setBand([g.x, x]);
                  else
                    setRange(
                      pan(
                        g.range,
                        (BigInt(Math.round((g.x - x) * 1024)) *
                          (g.range[1] - g.range[0])) /
                          BigInt(Math.round(plot * 1024)),
                        end,
                      ),
                    );
                }}
                onPointerUp={(e) => {
                  const g = gesture.current;
                  gesture.current = undefined;
                  setBand(undefined);
                  if (!g || g.button !== 0) return;
                  const x =
                    e.clientX -
                    e.currentTarget.getBoundingClientRect().left -
                    label;
                  if (g.moved) {
                    const from = timeAt(Math.min(g.x, x), range, plot);
                    const to = timeAt(Math.max(g.x, x), range, plot);
                    if (to - from >= 2n) setRange([from, to]);
                    return;
                  }
                  const row = shown[Math.floor(g.y / ROW)];
                  setOnB(e.shiftKey);
                  if (e.shiftKey) setOther(clicked(row, x));
                  else {
                    pick(row);
                    moveCursor(clicked(row, x));
                  }
                }}
              />
              {shown.map((row, i) => {
                const trace = traces[row.trace];
                if (!trace) return null;
                const style = { top: i * ROW, height: ROW, width: label };
                const key = `${row.trace}:${row.bit}`;
                const context = (e: React.MouseEvent) => {
                  e.preventDefault();
                  setMenu({
                    x: e.clientX,
                    y: Math.min(e.clientY, window.innerHeight - 190),
                    trace: row.trace,
                  });
                };
                const reorder = {
                  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
                    if (
                      e.button !== 0 ||
                      (e.target as HTMLElement).closest("button,input")
                    )
                      return;
                    gesture.current = {
                      x: row.trace,
                      y: e.clientY,
                      range,
                      button: -1,
                      moved: false,
                    };
                  },
                  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
                    const g = gesture.current;
                    if (g?.button !== -1) return;
                    if (!g.moved && Math.abs(e.clientY - g.y) <= 5) return;
                    if (!g.moved)
                      e.currentTarget.setPointerCapture(e.pointerId);
                    g.moved = true;
                    const top =
                      e.currentTarget.parentElement!.getBoundingClientRect()
                        .top;
                    setDrop(
                      shown[Math.floor((e.clientY - top) / ROW)]?.trace ??
                        traces.length,
                    );
                  },
                  onPointerUp: () => {
                    const g = gesture.current;
                    if (g?.button !== -1) return;
                    gesture.current = undefined;
                    if (g.moved && drop !== undefined)
                      onTraces((list) => moveTrace(list, g.x, drop));
                    setDrop(undefined);
                  },
                };
                const target =
                  drop === row.trace && shown[i - 1]?.trace !== row.trace
                    ? " drop"
                    : "";
                if ("divider" in trace)
                  return (
                    <div
                      className={`wave-name divider${target}`}
                      key={key}
                      style={style}
                      onContextMenu={context}
                      onDoubleClick={() => setRenaming(row.trace)}
                      {...reorder}
                    >
                      <button
                        aria-label={`Remove divider ${trace.divider}`}
                        onClick={() => remove(row.trace)}
                      >
                        ×
                      </button>
                      {renaming === row.trace ? (
                        <input
                          aria-label="Divider name"
                          autoFocus
                          defaultValue={trace.divider}
                          onBlur={(e) => {
                            edit(row.trace, { divider: e.target.value });
                            setRenaming(undefined);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") e.currentTarget.blur();
                          }}
                        />
                      ) : (
                        <span>{trace.divider}</span>
                      )}
                    </div>
                  );
                const v =
                  row.id === undefined ? undefined : info.variables[row.id];
                const path = trace.path.join(".");
                const value =
                  row.id === undefined ? undefined : values.get(row.id);
                return (
                  <div
                    className={`wave-name${row.id === selected && v ? " active" : ""}${v ? "" : " missing"}${target}`}
                    key={key}
                    style={style}
                    onClick={() => pick(row)}
                    onContextMenu={context}
                    title={v ? path : `${path} is not in this trace`}
                    {...reorder}
                  >
                    <button
                      aria-label={`Remove ${path}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        remove(row.trace);
                      }}
                    >
                      ×
                    </button>
                    {v && v.width > 1 && row.bit === undefined && (
                      <button
                        aria-label={`Expand ${path}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          edit(row.trace, { expanded: !trace.expanded });
                        }}
                      >
                        {trace.expanded ? "−" : "+"}
                      </button>
                    )}
                    <span>
                      {fullPaths ? path : trace.path.at(-1)}
                      {row.bit !== undefined ? `[${row.bit}]` : ""}
                    </span>
                    <small>
                      {v && v.width > 1 && row.bit === undefined
                        ? `[${v.index?.join(":") || v.width}]`
                        : ""}
                    </small>
                    {value !== undefined && (
                      <output>
                        {row.offset === undefined
                          ? formatValue(
                              value,
                              v?.width === 1 ? "bin" : (trace.radix ?? radix),
                            )
                          : value.replace("activity:", "")[row.offset]}
                      </output>
                    )}
                  </div>
                );
              })}
              {drop === traces.length && (
                <div className="wave-drop" style={{ top: count * ROW }} />
              )}
              <div
                className="wave-handle"
                role="separator"
                aria-label="Resize signal names"
                aria-orientation="vertical"
                style={{ left: label - 3, height: count * ROW }}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  gesture.current = {
                    x: e.clientX - label,
                    y: 0,
                    range,
                    button: -2,
                    moved: true,
                  };
                }}
                onPointerMove={(e) => {
                  const g = gesture.current;
                  if (g?.button === -2) setLabelWidth(e.clientX - g.x);
                }}
                onPointerUp={() => {
                  gesture.current = undefined;
                  setLabelWidth(label);
                }}
              />
            </div>
          </div>
        </div>
      </div>
      {menu && menuTrace && (
        <div
          className="command-menu source-context wave-menu"
          role="menu"
          aria-label="Trace actions"
          style={{ left: menu.x, top: menu.y }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setMenu(undefined);
          }}
        >
          {"path" in menuTrace && (
            <>
              <select
                aria-label="Radix of this trace"
                value={menuTrace.radix ?? ""}
                onChange={(e) =>
                  edit(menu.trace, {
                    radix: (e.target.value || undefined) as Radix | undefined,
                  })
                }
              >
                <option value="">Radix of the toolbar</option>
                {Object.entries(RADIXES).map(([value, name]) => (
                  <option key={value} value={value}>
                    {name}
                  </option>
                ))}
              </select>
              <div className="wave-colors">
                {Object.entries(COLORS).map(([name, color]) => (
                  <button
                    key={name}
                    role="menuitem"
                    aria-label={`${name} trace`}
                    style={{ background: color }}
                    onClick={() => edit(menu.trace, { color })}
                  />
                ))}
              </div>
              <hr />
            </>
          )}
          <button
            role="menuitem"
            onClick={() => {
              onTraces((list) => [
                ...list.slice(0, menu.trace),
                { divider: "Divider" },
                ...list.slice(menu.trace),
              ]);
              setRenaming(menu.trace);
              setMenu(undefined);
            }}
          >
            Add divider above
          </button>
          <button
            role="menuitem"
            onClick={() => {
              remove(menu.trace);
              setMenu(undefined);
            }}
          >
            Remove
          </button>
        </div>
      )}
    </section>
  );
}
