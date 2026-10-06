import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { position, formatValue } from "../selection";
import type { Run, WaveInfo, WaveRow } from "../types";
const ROW = 30,
  LABEL = 240;
export function Waveform({
  run,
  info,
  visible,
  selected,
  onSelect,
  onVisible,
  onCursor,
}: {
  run: Run;
  info: WaveInfo;
  visible: number[];
  selected?: number;
  onSelect: (id: number) => void;
  onVisible: (ids: number[]) => void;
  onCursor: (time: string) => void;
}) {
  const [expanded, setExpanded] = useState<number[]>([]);
  const displayed = useMemo(
    () =>
      visible.flatMap((id) => {
        const v = info.variables.find((v) => v.id === id);
        const base = { id, bit: undefined as number | undefined };
        return v && expanded.includes(id)
          ? [
              base,
              ...Array.from({ length: Math.min(v.width, 256) }, (_, index) => ({
                id,
                bit:
                  (v.index?.[0] ?? v.width - 1) +
                  (v.index && v.index[0] < v.index[1] ? index : -index),
              })),
            ]
          : [base];
      }),
    [visible, info.variables, expanded],
  );
  const [range, setRange] = useState<[bigint, bigint]>([
    0n,
    BigInt(info.end_time) || 1n,
  ]);
  const [cursor, setCursor] = useState(0n);
  const [radix, setRadix] = useState("hex");
  const [scroll, setScroll] = useState(0);
  const [rows, setRows] = useState<WaveRow[]>([]);
  const [error, setError] = useState("");
  const [viewport, setViewport] = useState({ width: 1000, height: 238 });
  const width = viewport.width;
  const container = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
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
  const ids = useMemo(() => shown.map((row) => row.id), [shown]);
  useEffect(() => {
    if (selected === undefined || !container.current) return;
    const index = displayed.findIndex((row) => row.id === selected);
    if (index < 0) return;
    const element = container.current;
    const top = index * ROW;
    if (
      top < element.scrollTop ||
      top + ROW > element.scrollTop + element.clientHeight
    )
      element.scrollTop = top;
  }, [selected, displayed]);
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
  useEffect(() => {
    let active = true;
    api<WaveRow[]>("wave_window", {
      run_id: run.id,
      ids,
      start: range[0].toString(),
      end: range[1].toString(),
      pixels: Math.max(1, width - LABEL),
    })
      .then((data) => {
        if (active) {
          setRows(data);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [run.id, ids, range, width]);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const height = count * ROW;
    c.width = width * dpr;
    c.height = height * dpr;
    c.style.width = width + "px";
    c.style.height = height + "px";
    const ctx = c.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.font = "11px ui-monospace, monospace";
    ctx.fillStyle = "#111b26";
    ctx.fillRect(0, 0, width, height);
    ctx.save();
    ctx.beginPath();
    ctx.rect(LABEL, 0, width - LABEL, height);
    ctx.clip();
    for (let r = 0; r < count; r++) {
      const id = ids[r],
        variable = info.variables.find((v) => v.id === id);
      const row = rows.find((x) => x.id === id);
      const y = r * ROW;
      ctx.strokeStyle = "#263646";
      ctx.beginPath();
      ctx.moveTo(LABEL, y + ROW);
      ctx.lineTo(width, y + ROW);
      ctx.stroke();
      if (id === selected) {
        ctx.fillStyle = "#1c3c46";
        ctx.fillRect(LABEL, y, width - LABEL, ROW);
      }
      const changes = row?.transitions || [];
      for (const [i, current] of changes.entries()) {
        const raw = current.value,
          bit = shown[r]?.bit;
        const offset =
          variable && bit !== undefined
            ? Math.abs((variable.index?.[0] ?? variable.width - 1) - bit)
            : 0;
        const value =
          bit === undefined
            ? raw
            : raw.startsWith("activity:")
              ? "activity:" + (raw.slice(9)[offset] || "x")
              : raw[offset] || "x";
        const x =
            LABEL +
            position(BigInt(current.time), range[0], range[1], width - LABEL),
          next = changes[i + 1];
        const right = next
          ? LABEL +
            position(BigInt(next.time), range[0], range[1], width - LABEL)
          : width;
        const x0 = Math.max(LABEL, x);
        ctx.strokeStyle = value.includes("x")
          ? "#e49b77"
          : value.includes("z")
            ? "#bfa4f4"
            : "#65d4bd";
        ctx.fillStyle = ctx.strokeStyle;
        if (
          (variable?.width === 1 || bit !== undefined) &&
          !value.startsWith("activity:") &&
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
            ctx.fillText(formatValue(value, radix), x0 + 7, y + 19);
        }
      }
    }
    const cx = LABEL + position(cursor, range[0], range[1], width - LABEL);
    ctx.strokeStyle = "#eec475";
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, height);
    ctx.stroke();
    ctx.restore();
  }, [
    rows,
    width,
    count,
    selected,
    cursor,
    range,
    radix,
    ids,
    shown,
    info.variables,
  ]);
  function zoom(factor: number) {
    const span = range[1] - range[0];
    const next = factor > 1 ? span * 2n : span / 2n || 1n;
    let start = cursor - next / 2n;
    if (start < 0n) start = 0n;
    setRange([start, start + next]);
  }
  return (
    <section className="wave-panel" id="waveform-pane">
      <div className="wave-toolbar">
        <strong>Waveforms</strong>
        <span className="muted">{info.timescale} / tick</span>
        <button onClick={() => zoom(0.5)}>Zoom in</button>
        <button onClick={() => zoom(2)}>Zoom out</button>
        <button onClick={() => setRange([0n, BigInt(info.end_time) || 1n])}>
          Full trace
        </button>
        <select
          aria-label="Radix"
          value={radix}
          onChange={(e) => setRadix(e.target.value)}
        >
          <option value="hex">Hex</option>
          <option value="bin">Binary</option>
          <option value="dec">Unsigned</option>
          <option value="signed">Signed</option>
        </select>
        <span className="cursor-label">Cursor {cursor.toString()}</span>
        <span>
          {range[0].toString()} — {range[1].toString()}
        </span>
      </div>
      {error && <div className="error">{error}</div>}
      <div
        className="wave-scroll"
        ref={container}
        onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
      >
        <div
          style={{
            height: Math.max(displayed.length * ROW, 160),
            position: "relative",
          }}
        >
          {!visible.length && (
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
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const row = Math.floor((e.clientY - rect.top) / ROW);
                if (ids[row] !== undefined) onSelect(ids[row]);
                const x = e.clientX - rect.left - LABEL;
                if (x >= 0) {
                  const t =
                    range[0] +
                    (BigInt(Math.round(x * 1024)) * (range[1] - range[0])) /
                      BigInt(Math.round((width - LABEL) * 1024));
                  setCursor(t);
                  onCursor(t.toString());
                }
              }}
            />
            {ids.map((id, i) => {
              const v = info.variables.find((v) => v.id === id)!;
              return (
                <div
                  className={`wave-name ${id === selected ? "active" : ""}`}
                  key={`${id}:${shown[i]?.bit}`}
                  style={{ top: i * ROW, height: ROW, width: LABEL }}
                  onClick={() => onSelect(id)}
                  title={v.path.join(".")}
                >
                  <button
                    aria-label={`Remove ${v.path.join(".")}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onVisible(visible.filter((x) => x !== id));
                    }}
                  >
                    ×
                  </button>
                  {v.width > 1 && shown[i]?.bit === undefined && (
                    <button
                      aria-label={`Expand ${v.path.join(".")}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setExpanded((items) =>
                          items.includes(id)
                            ? items.filter((x) => x !== id)
                            : [...items, id],
                        );
                      }}
                    >
                      {expanded.includes(id) ? "−" : "+"}
                    </button>
                  )}
                  <span>
                    {v.path.join(".")}
                    {shown[i]?.bit !== undefined ? `[${shown[i].bit}]` : ""}
                  </span>
                  <small>
                    {v.width > 1 && shown[i]?.bit === undefined
                      ? `[${v.index?.join(":") || v.width}]`
                      : ""}
                  </small>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
