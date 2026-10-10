import type { Timescale } from "./types";

export const RADIXES = {
  hex: "Hex",
  bin: "Binary",
  oct: "Octal",
  dec: "Unsigned",
  signed: "Signed",
  ascii: "ASCII",
  float: "Float",
} as const;
export type Radix = keyof typeof RADIXES;
/** Seconds exponent of each unit a time can be shown in. */
export const UNITS = {
  s: 0,
  ms: -3,
  us: -6,
  ns: -9,
  ps: -12,
  fs: -15,
} as const;
export type Unit = "auto" | "ticks" | keyof typeof UNITS;
export type Range = [bigint, bigint];
/** A row of the trace list. A signal is kept by path: variable ids differ between runs. */
export type Trace =
  | { path: string[]; radix?: Radix; color?: string; expanded?: boolean }
  | { divider: string };
export interface WaveView {
  range?: [string, string];
  cursor: string;
  other?: string;
  unit: Unit;
  labelWidth: number;
  fullPaths: boolean;
  radix: Radix;
}
const defaultView: WaveView = {
  cursor: "0",
  unit: "auto",
  labelWidth: 240,
  fullPaths: true,
  radix: "hex",
};

function unitFor(ticks: bigint, timescale: Timescale): keyof typeof UNITS {
  const names = Object.keys(UNITS) as (keyof typeof UNITS)[];
  const size = ticks * BigInt(timescale.factor);
  return (
    names.find((name) => {
      const shift = timescale.exponent - UNITS[name];
      return shift >= 0 || size >= 10n ** BigInt(-shift);
    }) ?? "fs"
  );
}
/** A time in ticks as exact text in a unit; `auto` takes the unit that leaves no leading zero. */
export function formatTime(
  ticks: bigint,
  timescale: Timescale | null | undefined,
  unit: Unit,
): string {
  if (ticks < 0n) return "-" + formatTime(-ticks, timescale, unit);
  if (!timescale || unit === "ticks" || ticks === 0n) return ticks.toString();
  const name = unit === "auto" ? unitFor(ticks, timescale) : unit;
  const shift = timescale.exponent - UNITS[name];
  const size = ticks * BigInt(timescale.factor);
  if (shift >= 0) return `${size * 10n ** BigInt(shift)} ${name}`;
  const divisor = 10n ** BigInt(-shift);
  const fraction = (size % divisor)
    .toString()
    .padStart(-shift, "0")
    .replace(/0+$/, "");
  return `${size / divisor}${fraction && "." + fraction} ${name}`;
}
/** The unit that suits a whole window, so every label on its ruler uses the same one. */
export function rulerUnit(
  range: Range,
  timescale: Timescale | null | undefined,
  unit: Unit,
): Unit {
  return unit === "auto" && timescale ? unitFor(range[1], timescale) : unit;
}
/** Frequency of a period given in ticks. */
export function formatFrequency(ticks: bigint, timescale: Timescale): string {
  const hertz =
    1 / (Number(ticks) * timescale.factor * 10 ** timescale.exponent);
  const prefixes = ["Hz", "kHz", "MHz", "GHz", "THz"];
  const step = Math.min(
    prefixes.length - 1,
    Math.max(0, Math.floor(Math.log10(hertz) / 3)),
  );
  return `${Number((hertz / 1000 ** step).toPrecision(4))} ${prefixes[step]}`;
}
/** Round times in a window, a 1-2-5 step apart and at least `spacing` pixels. */
export function rulerTicks(
  range: Range,
  width: number,
  spacing = 90,
): bigint[] {
  const span = range[1] - range[0];
  if (span <= 0n || width <= 0) return [];
  const least = (span * BigInt(spacing)) / BigInt(Math.round(width));
  let step = 1n;
  for (let decade = 1n; step < least; decade *= 10n)
    step =
      [1n, 2n, 5n].map((m) => m * decade).find((s) => s >= least) ??
      10n * decade;
  const ticks = [];
  for (
    let time = ((range[0] + step - 1n) / step) * step;
    time <= range[1];
    time += step
  )
    ticks.push(time);
  return ticks;
}
function clamp(start: bigint, span: bigint, end: bigint): Range {
  let first = start + span > end ? end - span : start;
  if (first < 0n) first = 0n;
  return [first, first + span];
}
/** Scale a window by `factor`, keeping `anchor` at the same place in it. */
export function zoomAt(
  range: Range,
  anchor: bigint,
  factor: number,
  end: bigint,
): Range {
  const span = range[1] - range[0];
  let next = (span * BigInt(Math.round(factor * 1024))) / 1024n;
  if (next < 2n) next = 2n;
  if (next > end) next = end > 2n ? end : 2n;
  return clamp(anchor - ((anchor - range[0]) * next) / (span || 1n), next, end);
}
export function pan(range: Range, delta: bigint, end: bigint): Range {
  return clamp(range[0] + delta, range[1] - range[0], end);
}

export function pathKey(path: string[]): string {
  return JSON.stringify(path);
}
export function addTraces(traces: Trace[], paths: string[][]): Trace[] {
  const present = new Set(
    traces.flatMap((t) => ("path" in t ? [pathKey(t.path)] : [])),
  );
  const added = paths.filter((path) => {
    const key = pathKey(path);
    return !present.has(key) && present.add(key);
  });
  return added.length
    ? [...traces, ...added.map((path) => ({ path }))]
    : traces;
}
/** Move a row so that it stands before the row now at `to`. */
export function moveTrace(traces: Trace[], from: number, to: number): Trace[] {
  if (!traces[from] || to === from || to === from + 1) return traces;
  const next = traces.filter((_, index) => index !== from);
  const place = to > from ? to - 1 : to;
  next.splice(Math.max(0, Math.min(next.length, place)), 0, traces[from]);
  return next;
}

function stored(name: string, key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(`${name}:${key}`) ?? "null");
  } catch {
    return null;
  }
}
function store(name: string, key: string, value: unknown) {
  try {
    localStorage.setItem(`${name}:${key}`, JSON.stringify(value));
  } catch {
    // The list still works for this session when storage is unavailable.
  }
}
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
/** The trace list saved for a project, stage and testbench; nothing when none was saved. */
export function readTraces(key: string): Trace[] | undefined {
  const saved = stored("hdlview-waves", key);
  if (!Array.isArray(saved)) return undefined;
  return saved.flatMap((item: unknown): Trace[] => {
    if (!item || typeof item !== "object") return [];
    if ("divider" in item && typeof item.divider === "string")
      return [{ divider: item.divider }];
    if (!("path" in item) || !strings(item.path)) return [];
    const trace: Trace = { path: item.path };
    if (
      "radix" in item &&
      typeof item.radix === "string" &&
      item.radix in RADIXES
    )
      trace.radix = item.radix as Radix;
    if ("color" in item && typeof item.color === "string")
      trace.color = item.color;
    if ("expanded" in item && item.expanded === true) trace.expanded = true;
    return [trace];
  });
}
export function writeTraces(key: string, traces: Trace[]) {
  store("hdlview-waves", key, traces);
}
const time = (value: unknown): value is string =>
  typeof value === "string" && /^\d+$/.test(value);
export function readView(key: string): WaveView {
  const saved = stored("hdlview-wave-view", key);
  if (!saved || typeof saved !== "object") return defaultView;
  const view = { ...defaultView };
  if (
    "range" in saved &&
    Array.isArray(saved.range) &&
    saved.range.length === 2 &&
    saved.range.every(time)
  )
    view.range = saved.range as [string, string];
  if ("cursor" in saved && time(saved.cursor)) view.cursor = saved.cursor;
  if ("other" in saved && time(saved.other)) view.other = saved.other;
  if (
    "unit" in saved &&
    typeof saved.unit === "string" &&
    (saved.unit in UNITS || saved.unit === "ticks")
  )
    view.unit = saved.unit as Unit;
  if ("labelWidth" in saved && typeof saved.labelWidth === "number")
    view.labelWidth = saved.labelWidth;
  if ("fullPaths" in saved && saved.fullPaths === false) view.fullPaths = false;
  if (
    "radix" in saved &&
    typeof saved.radix === "string" &&
    saved.radix in RADIXES
  )
    view.radix = saved.radix as Radix;
  return view;
}
export function writeView(key: string, view: WaveView) {
  store("hdlview-wave-view", key, view);
}
