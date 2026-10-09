import type { Node, Port } from "./types";

export const GEOMETRY_VERSION = 6;
interface SymbolPath {
  d: string;
  fill?: boolean;
  className?: string;
}
interface SymbolText {
  x: number;
  y: number;
  text: string;
  anchor?: "start" | "middle" | "end";
  secondary?: boolean;
}
interface PinAnchor {
  id: string;
  /** Where a wire meets the pin: the outer end of its lead. */
  x: number;
  y: number;
  side: "WEST" | "EAST" | "SOUTH" | "NORTH";
  label: string;
  labelX: number;
  labelY: number;
  anchor: "start" | "middle" | "end";
  lead: string;
  /** The lead carries more than one bit. */
  bus: boolean;
  bubble?: [number, number];
  clock?: string;
  /** Length outside the symbol reserved for the lead and its note. */
  reach: number;
  /** A slice taken from a bus, a constant tied to the pin, or a bus width. */
  note?: { text: string; x: number; y: number; anchor: "start" | "end" };
  /** Slash across the lead of a bus whose width the symbol does not label. */
  mark?: string;
  /** A constant or undriven input: nothing is routed to this pin. */
  unwired?: boolean;
}
export interface SymbolGeometry {
  width: number;
  height: number;
  paths: SymbolPath[];
  texts: SymbolText[];
  pins: PinAnchor[];
  symbol: string;
}

/** Distance between neighbouring pins on one side, shared by every symbol. */
const PITCH = 20;
/** Wire stub between the edge of a symbol's box and its body. */
const LEAD = 10;

export function shortName(text: string, max = 30): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}
export function pinTitle(node: Node, port: Port): string {
  return `Pin ${port.display.name || port.label} · ${node.label} · ${port.display.width} bits`;
}
export function pinLabel(port: Port): string {
  const d = port.display;
  if (!d) return port.label;
  if (d.declared_direction && d.range)
    return `${d.name}[${d.range[0]}:${d.range[1]}]`;
  return port.label;
}
const isBus = (port: Port) => port.display.width > 1;
const logic = new Set([
  "and",
  "nand",
  "or",
  "nor",
  "xor",
  "xnor",
  "not",
  "buffer",
]);
const selectors = new Set(["mux", "demux", "encoder", "decoder"]);
const arrows = new Set(["constant", "connector"]);

type Lead = Pick<
  PinAnchor,
  "x" | "lead" | "reach" | "note" | "mark" | "unwired"
>;

/**
 * A left-side input pin's lead outside the symbol. A pin taking part of a bus
 * names that part above the lead; a constant or undriven pin shows its value
 * in place of a wire. Pins joined from several sources are drawn by their join.
 */
function westLead(port: Port, y: number, body: number): Lead {
  const feeds = port.feeds ?? [];
  const only = feeds.length === 1 ? feeds[0] : undefined;
  if (only?.kind === "net" && only.label) {
    const reach = only.label.length * 6 + 10;
    return {
      x: -reach,
      reach,
      lead: `M${-reach},${y} H${body}`,
      note: { text: only.label, x: -4, y: y - 7, anchor: "end" },
    };
  }
  if (!feeds.length || feeds.some((feed) => feed.kind === "net"))
    return { x: 0, reach: 0, lead: `M0,${y} H${body}` };
  const values = [...feeds]
    .reverse()
    .map((feed) => (feed.kind === "constant" ? feed.label : "undriven"));
  const text =
    values.length === 1 ? (values[0] ?? "") : `{${values.join(", ")}}`;
  return {
    x: -8,
    reach: text.length * 6 + 14,
    lead: `M-8,${y} H${body}`,
    note: { text, x: -11, y, anchor: "end" },
    unwired: true,
  };
}

/**
 * A right-side pin's lead from `body` to the box edge. A bus leaving a symbol
 * that does not label pin widths is marked with a slash and its width.
 */
function eastLead(
  port: Port,
  y: number,
  body: number,
  edge: number,
  marked: boolean,
): Lead {
  const width = port.display.width;
  if (!marked || width < 2)
    return { x: edge, reach: 0, lead: `M${edge},${y} H${body}` };
  const text = String(width);
  const reach = 14 + text.length * 6;
  return {
    x: edge + reach,
    reach,
    lead: `M${edge + reach},${y} H${body}`,
    mark: `M${edge + 3},${y + 4} L${edge + 9},${y - 4}`,
    note: { text, x: edge + 12, y: y - 7, anchor: "start" },
  };
}

export function boundaryDirection(node: Node): string {
  return node.ports[0]?.display.declared_direction ?? "input";
}

function boundaryGeometry(node: Node): SymbolGeometry {
  const direction = boundaryDirection(node);
  const labels = node.ports.map((p) => shortName(pinLabel(p), 30));
  const width = Math.max(76, ...labels.map((label) => label.length * 6.2 + 32));
  const header = node.ports.length > 1 ? 20 : 0;
  const paths: SymbolPath[] = [];
  const pins = node.ports.map((p, i): PinAnchor => {
    const top = header + i * 32 + 4,
      y = top + 12;
    const x = 8,
      right = width - 8;
    const d =
      direction === "input"
        ? `M${x},${top} H${right - 8} L${right},${y} L${right - 8},${top + 24} H${x} Z`
        : direction === "inout"
          ? `M${x + 8},${top} H${right - 8} L${right},${y} L${right - 8},${top + 24} H${x + 8} L${x},${y} Z`
          : `M${x},${top} H${right - 8} L${right},${y} L${right - 8},${top + 24} H${x} L${x + 8},${y} Z`;
    paths.push({ d, fill: true, className: "nodebox" });
    const input = direction === "input";
    return {
      id: p.id,
      y,
      side: input ? "EAST" : "WEST",
      label: labels[i] ?? p.label,
      labelX: width / 2,
      labelY: y,
      anchor: "middle",
      bus: isBus(p),
      ...(input
        ? eastLead(p, y, right, width, false)
        : westLead(p, y, direction === "output" ? x + 8 : x)),
    };
  });
  return {
    width,
    height: header + Math.max(1, pins.length) * 32,
    symbol: "port",
    paths,
    pins,
    texts: header
      ? [
          {
            x: width / 2,
            y: 12,
            text: shortName(node.label),
            anchor: "middle",
            secondary: true,
          },
        ]
      : [],
  };
}

/** A concatenation: ordered inputs gathered on a bar into one bus. */
function joinGeometry(node: Node): SymbolGeometry {
  const inputs = node.ports.filter((p) => p.direction !== "output"),
    outputs = node.ports.filter((p) => p.direction === "output");
  const bar = LEAD + Math.max(0, ...inputs.map((p) => p.label.length * 6)) + 8;
  const height = Math.max(inputs.length, outputs.length) * PITCH + 8;
  const pins: PinAnchor[] = [
    ...inputs.map((p, i): PinAnchor => {
      const y = 4 + PITCH / 2 + i * PITCH;
      return {
        id: p.id,
        y,
        side: "WEST",
        label: p.label,
        labelX: bar - 5,
        labelY: y - 7,
        anchor: "end",
        bus: isBus(p),
        ...westLead(p, y, bar),
      };
    }),
    ...outputs.map((p, i): PinAnchor => {
      const y = (height * (i + 1)) / (outputs.length + 1);
      return {
        id: p.id,
        y,
        side: "EAST",
        label: "",
        labelX: bar,
        labelY: y,
        anchor: "start",
        bus: isBus(p),
        ...eastLead(p, y, bar, bar + LEAD, true),
      };
    }),
  ];
  return {
    width: bar + LEAD,
    height,
    symbol: "bus_split",
    paths: [{ d: `M${bar},2 V${height - 2}`, fill: false, className: "join" }],
    texts: [],
    pins,
  };
}

/** Shared drawing bounds and wire anchors; ELK may position nodes, never their pins. */
export function symbolGeometry(node: Node): SymbolGeometry {
  const { symbol, title } = node.display;
  if (symbol === "port") return boundaryGeometry(node);
  if (symbol === "bus_split") return joinGeometry(node);
  if (symbol === "junction")
    return {
      width: 0,
      height: 0,
      symbol,
      paths: [],
      texts: [],
      pins: node.ports.map((p) => ({
        id: p.id,
        x: 0,
        y: 0,
        side: p.direction === "output" ? "EAST" : "WEST",
        label: "",
        labelX: 0,
        labelY: 0,
        anchor: "middle",
        lead: "",
        bus: false,
        reach: 0,
      })),
    };
  const gate = logic.has(symbol),
    selector = selectors.has(symbol),
    operator = symbol === "operator",
    arrow = arrows.has(symbol),
    sequential = symbol === "register" || symbol === "latch";
  const box = !gate && !selector && !operator && !arrow;
  // Synchronous inputs enter on the left with the data. Only asynchronous
  // clear and load enter from below, and asynchronous preset from above.
  const ports = node.ports.filter(
    (p) => !["power", "unused"].includes(p.display.role),
  );
  const triangle = symbol === "buffer" || symbol === "not";
  const side = (p: Port): PinAnchor["side"] =>
    p.direction === "output"
      ? "EAST"
      : triangle && p.display.role !== "data"
        ? "SOUTH"
        : !p.display.asynchronous
          ? "WEST"
          : p.display.role === "set"
            ? "NORTH"
            : "SOUTH";
  const on = (s: PinAnchor["side"]) => ports.filter((p) => side(p) === s);
  const west = on("WEST"),
    east = on("EAST"),
    south = on("SOUTH"),
    north = on("NORTH");
  // Boxes label pins with their width; gates rely on shape and the bus mark.
  const text = (p: Port): string => {
    const role = p.display.role;
    // An instance pin reaching mixed polarities is not an unknown polarity.
    const unknown =
      ["clock", "enable", "reset", "set"].includes(role) &&
      p.display.polarity == null &&
      !node.child_scope;
    const name =
      box && isBus(p) && !p.label.endsWith("]")
        ? `${p.label}[${p.display.width - 1}:0]`
        : (gate && role === "data") ||
            arrow ||
            (!box && p.direction === "output" && east.length === 1)
          ? ""
          : p.label;
    return shortName(name, 18) + (unknown && name ? " ?" : "");
  };
  const span = (ps: Port[]) =>
    Math.max(0, ...ps.map((p) => text(p).length * 6));
  const heading =
    symbol === "compound"
      ? title.toUpperCase()
      : box && !sequential
        ? title
        : "";
  const header = heading ? 18 : 0;
  // Room inside a box for the bars or brackets that mark its kind.
  const pad = symbol === "memory" ? 12 : 5;
  const rows = Math.max(west.length, east.length, 1);
  const w = Math.max(
    gate
      ? (triangle ? 34 : 44) + span(west)
      : operator
        ? Math.max(56, title.length * 8 + span(west) + 30)
        : arrow
          ? title.length * 7 + 22
          : selector
            ? Math.max(44, span(west) + span(east) + 26)
            : Math.max(
                sequential ? 60 : 72,
                span(west) + span(east) + 20 + 2 * pad,
              ),
    symbol === "compound" ? span(west) + span(east) + 140 : 0,
    heading ? shortName(heading).length * 7 + 16 : 0,
    Math.max(south.length, north.length) * 44,
  );
  const inset = (south.length ? 12 : 0) + (north.length ? 12 : 0);
  const h = gate
    ? Math.max(30, rows * PITCH + 4)
    : operator
      ? Math.max(36, rows * PITCH + 12)
      : arrow
        ? 26
        : selector
          ? header + rows * PITCH + 16
          : Math.max(40, header + rows * PITCH + 10 + inset);
  // A register is named after the net it drives and a decoder, encoder or
  // wide multiplexer by its function; other symbols by instance.
  const name =
    sequential || selector
      ? ["DFF", "LATCH", "MUX"].includes(title)
        ? ""
        : title
      : !node.label.startsWith("$") && node.label !== title
        ? node.label
        : "";
  const inner = (west.length ? LEAD : 0) + w + (east.length ? LEAD : 0);
  // A long name may widen its symbol a little; beyond that it is shortened.
  const width = Math.max(inner, Math.min(name.length * 7 + 4, inner + 48));
  const x = (width - inner) / 2 + (west.length ? LEAD : 0),
    y = (name ? 16 : 0) + (north.length ? LEAD : 0);
  const height = y + h + (south.length ? LEAD : 0);
  const paths: SymbolPath[] = [];
  const texts: SymbolText[] = [];
  const pins: PinAnchor[] = [];
  const body = (d: string, fill = true) =>
    paths.push({ d, fill, className: "nodebox" });
  if (symbol === "and" || symbol === "nand")
    body(
      `M${x},${y} H${x + w / 2} C${x + w * 1.16},${y} ${x + w * 1.16},${y + h} ${x + w / 2},${y + h} H${x} Z`,
    );
  else if (["or", "nor", "xor", "xnor"].includes(symbol)) {
    body(
      `M${x},${y} Q${x + w * 0.62},${y - 2} ${x + w},${y + h / 2} Q${x + w * 0.62},${y + h + 2} ${x},${y + h} Q${x + w * 0.3},${y + h / 2} ${x},${y} Z`,
    );
    if (symbol === "xor" || symbol === "xnor")
      paths.push({
        d: `M${x - 6},${y} Q${x + w * 0.3 - 6},${y + h / 2} ${x - 6},${y + h}`,
        fill: false,
      });
  } else if (symbol === "not" || symbol === "buffer")
    body(`M${x},${y} L${x + w - 8},${y + h / 2} L${x},${y + h} Z`);
  else if (symbol === "mux" || symbol === "encoder")
    body(`M${x},${y} L${x + w},${y + 10} V${y + h - 10} L${x},${y + h} Z`);
  else if (symbol === "demux" || symbol === "decoder")
    body(`M${x},${y + 10} L${x + w},${y} V${y + h} L${x},${y + h - 10} Z`);
  else if (operator)
    body(
      `M${x + 10},${y} H${x + w - 10} L${x + w},${y + 10} V${y + h - 10} L${x + w - 10},${y + h} H${x + 10} L${x},${y + h - 10} V${y + 10} Z`,
    );
  else if (arrow)
    body(
      `M${x},${y} H${x + w - 10} L${x + w},${y + h / 2} L${x + w - 10},${y + h} H${x} Z`,
    );
  else {
    body(
      `M${x + 3},${y} H${x + w - 3} Q${x + w},${y} ${x + w},${y + 3} V${y + h - 3} Q${x + w},${y + h} ${x + w - 3},${y + h} H${x + 3} Q${x},${y + h} ${x},${y + h - 3} V${y + 3} Q${x},${y} ${x + 3},${y} Z`,
    );
    if (symbol === "memory")
      paths.push({
        d: `M${x + 4},${y + header} V${y + h - 4} M${x + 7},${y + header} V${y + h - 4}`,
        fill: false,
      });
  }
  if (heading)
    texts.push({
      x: x + w / 2,
      y: y + 14,
      text: shortName(heading),
      anchor: "middle",
    });
  if (operator || arrow || (gate && ["&&", "||", "!"].includes(title)))
    texts.push({
      x: x + (gate ? w * 0.42 : w / 2),
      y: y + h / 2 + 4,
      text: shortName(title),
      anchor: "middle",
    });
  if (name)
    texts.push({
      x: width / 2,
      y: 11,
      text: shortName(name, Math.max(4, Math.floor(width / 7))),
      anchor: "middle",
      secondary: !sequential && !node.child_scope,
    });
  // Boxes keep both sides on one grid from the top, so a datapath runs
  // straight through D and Q. Shaped symbols centre each side.
  const first = (count: number) =>
    box
      ? y + header + (north.length ? 12 : 0) + 5 + PITCH / 2
      : y + header + (h - header - count * PITCH) / 2 + PITCH / 2;
  const make = (p: Port, index: number, count: number) => {
    const left = side(p) === "WEST";
    const py = first(count) + index * PITCH;
    let px = left ? x : x + w;
    if (left && ["or", "nor", "xor", "xnor"].includes(symbol))
      px += w * 0.6 * ((py - y) / h) * (1 - (py - y) / h);
    if (!left && triangle) px -= 8;
    const inverted =
      (!left && ["not", "nand", "nor", "xnor"].includes(symbol)) ||
      p.display.polarity === false;
    const bubble: [number, number] | undefined = inverted
      ? [left ? px - 4 : px + 4, py]
      : undefined;
    const contact = px + (inverted ? (left ? -8 : 8) : 0);
    const clock = p.display.role === "clock";
    pins.push({
      id: p.id,
      y: py,
      side: left ? "WEST" : "EAST",
      label: text(p),
      labelX: left ? px + (clock ? pad + 7 : pad) : px - pad,
      labelY: py,
      anchor: left ? "start" : "end",
      bus: isBus(p),
      bubble,
      // Inside a box that marks its kind along the left edge, the wedge
      // starts after that mark.
      clock: clock
        ? `M${px + pad - 5},${py - 5} L${px + pad + 3},${py} L${px + pad - 5},${py + 5}`
        : undefined,
      ...(left
        ? westLead(p, py, contact)
        : eastLead(p, py, contact, width, !box)),
    });
  };
  west.forEach((p, i) => make(p, i, west.length));
  east.forEach((p, i) => make(p, i, east.length));
  for (const [list, bottom] of [
    [south, true],
    [north, false],
  ] as const)
    list.forEach((p, i) => {
      const px = x + ((triangle ? w - 8 : w) * (i + 1)) / (list.length + 1);
      // A buffer's enable meets the sloped lower edge of its triangle.
      const edge = triangle
          ? y + h - ((h / 2) * (px - x)) / (w - 8)
          : bottom
            ? y + h
            : y,
        outer = bottom ? height : 0,
        out = bottom ? 1 : -1;
      const inverted = p.display.polarity === false;
      const value = (p.feeds ?? []).find((feed) => feed.kind !== "net");
      pins.push({
        id: p.id,
        x: px,
        y: outer,
        side: bottom ? "SOUTH" : "NORTH",
        label: text(p),
        labelX: triangle ? px + 4 : px,
        labelY: triangle ? outer - 4 : edge - out * 8,
        anchor: triangle ? "start" : "middle",
        lead: `M${px},${outer} V${edge + (inverted ? out * 8 : 0)}`,
        bus: isBus(p),
        bubble: inverted ? [px, edge + out * 4] : undefined,
        reach: 0,
        note: value
          ? {
              text: value.kind === "constant" ? value.label : "undriven",
              x: px + 5,
              y: outer - out * 3,
              anchor: "start",
            }
          : undefined,
        unwired: Boolean(value),
      });
    });
  const compound = node.display.compound;
  const output = pins.find((p) => p.side === "EAST");
  if (compound && output)
    paths.push(
      ...compoundPaths(
        compound,
        new Map(
          pins
            .filter((p) => p.side === "WEST")
            .map((p) => [
              ports.find((port) => port.id === p.id)?.display.name ?? "",
              p,
            ]),
        ),
        output,
        x + span(west) + 20,
        x + w - span(east) - 16,
      ),
    );
  return { width, height, paths, texts, pins, symbol };
}

/**
 * Gates of a two-level cell between `from` and `to`: one per group of two or
 * more pins, all feeding the second gate on the output's row.
 */
function compoundPaths(
  compound: NonNullable<Node["display"]["compound"]>,
  inputs: Map<string, PinAnchor>,
  output: PinAnchor,
  from: number,
  to: number,
): SymbolPath[] {
  const paths: SymbolPath[] = [];
  const glyph = (gx: number, gy: number, and: boolean) =>
    paths.push({
      d: and
        ? `M${gx},${gy - 10} H${gx + 10} Q${gx + 34},${gy} ${gx + 10},${gy + 10} H${gx} Z`
        : `M${gx},${gy - 10} Q${gx + 16},${gy - 10} ${gx + 28},${gy} Q${gx + 16},${gy + 10} ${gx},${gy + 10} Q${gx + 9},${gy} ${gx},${gy - 10} Z`,
      fill: true,
    });
  const line = (d: string) => paths.push({ d, fill: false });
  const and = compound.first === "and";
  const firstX = from + 16,
    secondX = to - 41;
  glyph(secondX, output.y, !and);
  compound.groups.forEach((group, g) => {
    const members = group.flatMap((name) => inputs.get(name) ?? []);
    const center =
      members.reduce((sum, pin) => sum + pin.y, 0) / (members.length || 1);
    // Inputs of the second gate spread around the output's row.
    const entry = output.y + (g - (compound.groups.length - 1) / 2) * 5;
    const turn = secondX - 8 - g * 4;
    if (members.length > 1) {
      glyph(firstX, center, and);
      members.forEach((pin, i) => {
        const at = center + (i - (members.length - 1) / 2) * 5;
        line(`M${from},${pin.y} H${firstX - 6} V${at} H${firstX}`);
      });
      line(`M${firstX + 28},${center} H${turn} V${entry} H${secondX}`);
    } else if (members[0])
      line(`M${from},${members[0].y} H${turn} V${entry} H${secondX}`);
  });
  if (compound.inverted)
    paths.push({
      d: `M${secondX + 28},${output.y} a4,4 0 1,0 8,0 a4,4 0 1,0 -8,0`,
      fill: true,
    });
  line(`M${secondX + (compound.inverted ? 36 : 28)},${output.y} H${to}`);
  return paths;
}
