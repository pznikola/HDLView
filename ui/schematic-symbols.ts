import type { Node, Port } from "./types";

export const GEOMETRY_VERSION = 3;
export interface SymbolPath {
  d: string;
  fill?: boolean;
  className?: string;
}
export interface SymbolText {
  x: number;
  y: number;
  text: string;
  anchor?: "start" | "middle" | "end";
  secondary?: boolean;
}
export interface PinAnchor {
  id: string;
  x: number;
  y: number;
  side: "WEST" | "EAST" | "SOUTH" | "NORTH";
  label: string;
  labelX: number;
  labelY: number;
  anchor: "start" | "middle" | "end";
  lead: string;
  bubble?: [number, number];
  clock?: string;
}
export interface SymbolGeometry {
  width: number;
  height: number;
  paths: SymbolPath[];
  texts: SymbolText[];
  pins: PinAnchor[];
  symbol: string;
}

export function shortName(text: string, max = 30): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}
export function pinLabel(port: Port): string {
  const d = port.display;
  if (!d) return port.label;
  if (d.declared_direction && d.range)
    return `${d.name}[${d.range[0]}:${d.range[1]}]`;
  return port.label;
}
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
const boxed = new Set([
  "module",
  "unknown",
  "register",
  "latch",
  "memory",
  "compound",
  "process",
  "function",
  "task",
  "behavior",
  "assignment",
  "physical",
]);

export function boundaryDirection(node: Node): string {
  return (
    node.ports[0]?.display?.declared_direction ??
    (node.ports[0]?.direction === "output" ? "input" : "output")
  );
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
      x: input ? width : 0,
      y,
      side: input ? "EAST" : "WEST",
      label: labels[i] ?? p.label,
      labelX: width / 2,
      labelY: y,
      anchor: "middle",
      lead: input
        ? `M${right},${y} H${width}`
        : `M0,${y} H${direction === "output" ? x + 8 : x}`,
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

/** Shared drawing bounds and wire anchors; ELK may position nodes, never their pins. */
export function symbolGeometry(node: Node): SymbolGeometry {
  const symbol =
    node.display?.symbol ?? (node.kind === "port" ? "port" : "unknown");
  const title = node.display?.title ?? node.kind;
  if (symbol === "port") return boundaryGeometry(node);
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
      })),
    };
  if (symbol === "bus_split") {
    const ins = node.ports.filter((p) => p.direction !== "output"),
      outs = node.ports.filter((p) => p.direction === "output");
    const height = Math.max(ins.length, outs.length) * 22 + 20;
    const pins: PinAnchor[] = [];
    for (const [list, side] of [
      [ins, "WEST"],
      [outs, "EAST"],
    ] as const)
      list.forEach((p, i) => {
        const y = 10 + ((height - 20) * (i + 1)) / (list.length + 1),
          x = side === "WEST" ? 0 : 56;
        pins.push({
          id: p.id,
          x,
          y,
          side,
          label: p.label,
          labelX: side === "WEST" ? 22 : 34,
          labelY: y,
          anchor: side === "WEST" ? "end" : "start",
          lead: `M${x},${y} H28`,
        });
      });
    return {
      width: 56,
      height,
      symbol,
      paths: [{ d: `M28,8 V${height - 8}`, fill: false }],
      texts: [],
      pins,
    };
  }
  const ports = node.ports.filter((p) => p.display?.role !== "power");
  const incoming = ports.filter(
    (p) =>
      p.direction !== "output" &&
      !["select", "enable", "reset", "set"].includes(p.display?.role ?? "data"),
  );
  const outgoing = ports.filter((p) => p.direction === "output");
  const controls = ports.filter(
    (p) =>
      p.direction !== "output" &&
      ["select", "enable", "reset", "set"].includes(p.display?.role ?? "data"),
  );
  incoming.sort(
    (a, b) =>
      Number(a.display?.role === "clock") - Number(b.display?.role === "clock"),
  );
  const functionalHeader = ["mux", "demux", "encoder", "decoder"].includes(
    symbol,
  );
  const pinTextWidth = (ps: Port[]) =>
    Math.max(0, ...ps.map((p) => shortName(pinLabel(p), 18).length * 6));
  const controlWidth = Math.max(
    24,
    ...controls.map((p) => shortName(pinLabel(p), 14).length * 6 + 18),
  );
  const w = Math.max(
    boxed.has(symbol) || functionalHeader ? 136 : 72,
    pinTextWidth(incoming) +
      pinTextWidth(outgoing) +
      (symbol === "compound" ? 140 : 52),
    !logic.has(symbol) && !boxed.has(symbol) && !functionalHeader
      ? shortName(title).length * 7 +
          pinTextWidth(incoming) +
          pinTextWidth(outgoing) +
          48
      : 0,
    controls.length ? (controls.length + 1) * controlWidth : 0,
    !logic.has(symbol) ? Math.min(250, shortName(title).length * 7 + 32) : 0,
  );
  const top = boxed.has(symbol) ? 30 : functionalHeader ? 24 : 0;
  const footer = controls.length ? 24 : 0;
  const h =
    Math.max(54, Math.max(incoming.length, outgoing.length) * 24 + top + 12) +
    footer;
  const annotations = shortName(
    node.display?.annotations.join(" · ") ?? "",
    36,
  );
  const labelWidth = Math.max(
    !node.label.startsWith("$") && node.label !== title
      ? shortName(node.label).length * 7 + 12
      : 0,
    annotations.length * 6 + 12,
  );
  const width = Math.max(w + 36, labelWidth);
  const x = (width - w) / 2,
    y = annotations ? 46 : 30;
  const height = y + h + (controls.length ? 22 : 0);
  const paths: SymbolPath[] = [];
  const texts: SymbolText[] = [];
  const pins: PinAnchor[] = [];
  const body = (d: string, fill = true) =>
    paths.push({ d, fill, className: "nodebox" });
  if (["and", "nand"].includes(symbol))
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
    body(`M${x},${y} L${x + w},${y + 12} V${y + h - 12} L${x},${y + h} Z`);
  else if (symbol === "demux" || symbol === "decoder")
    body(`M${x},${y + 12} L${x + w},${y} V${y + h} L${x},${y + h - 12} Z`);
  else if (symbol === "operator")
    body(
      `M${x + 12},${y} H${x + w - 12} L${x + w},${y + 12} V${y + h - 12} L${x + w - 12},${y + h} H${x + 12} L${x},${y + h - 12} V${y + 12} Z`,
    );
  else if (
    symbol === "constant" ||
    symbol === "connector" ||
    symbol === "unavailable"
  )
    body(
      `M${x},${y + 6} H${x + w - 10} L${x + w},${y + h / 2} L${x + w - 10},${y + h - 6} H${x} Z`,
    );
  else {
    body(
      `M${x + 5},${y} H${x + w - 5} Q${x + w},${y} ${x + w},${y + 5} V${y + h - 5} Q${x + w},${y + h} ${x + w - 5},${y + h} H${x + 5} Q${x},${y + h} ${x},${y + h - 5} V${y + 5} Q${x},${y} ${x + 5},${y} Z`,
    );
    if (symbol === "memory")
      paths.push({
        d: `M${x + 7},${y + 7} V${y + h - 7} M${x + 11},${y + 7} V${y + h - 7}`,
        fill: false,
      });
    if (["process", "function", "task"].includes(symbol))
      paths.push({
        d: `M${x + 9},${y + 7} H${x + 4} V${y + h - 7} H${x + 9} M${x + w - 9},${y + 7} H${x + w - 4} V${y + h - 7} H${x + w - 9}`,
        fill: false,
      });
    if (symbol === "compound") {
      texts.push({
        x: x + w / 2,
        y: y + 16,
        text: shortName(title.toUpperCase()),
        anchor: "middle",
      });
    }
  }
  if (!logic.has(symbol) && symbol !== "compound")
    texts.push({
      x: x + w / 2,
      y: y + (boxed.has(symbol) || functionalHeader ? 18 : h / 2 + 4),
      text: shortName(title),
      anchor: "middle",
    });
  if (!node.label.startsWith("$") && node.label !== title)
    texts.push({
      x: x + w / 2,
      y: 18,
      text: shortName(node.label),
      anchor: "middle",
      secondary: !node.child_scope,
    });
  if (logic.has(symbol) && ["&&", "||", "!"].includes(title))
    texts.push({
      x: x + w / 2,
      y: y + h / 2 + 4,
      text: title,
      anchor: "middle",
    });
  const make = (
    p: Port,
    index: number,
    count: number,
    side: PinAnchor["side"],
  ) => {
    const py = y + top + ((h - top - footer) * (index + 1)) / (count + 1);
    let px = side === "WEST" ? x : x + w;
    if (side === "WEST" && ["or", "nor", "xor", "xnor"].includes(symbol))
      px += w * 0.6 * ((py - y) / h) * (1 - (py - y) / h);
    if (side === "EAST" && (symbol === "buffer" || symbol === "not")) px -= 8;
    const inverted =
      (side === "EAST" && ["not", "nand", "nor", "xnor"].includes(symbol)) ||
      p.display?.polarity === false;
    const ax = side === "WEST" ? 0 : width;
    const bubble: [number, number] | undefined = inverted
      ? [side === "WEST" ? px - 4 : px + 4, py]
      : undefined;
    const lead = `M${ax},${py} H${px + (inverted ? (side === "WEST" ? -8 : 8) : 0)}`;
    const label =
      shortName(pinLabel(p), 18) +
      (p.display &&
      ["clock", "enable", "reset", "set"].includes(p.display.role) &&
      p.display.polarity == null
        ? " ?"
        : "");
    const clock =
      p.display?.role === "clock"
        ? `M${px},${py - 5} L${px + 8},${py} L${px},${py + 5}`
        : undefined;
    pins.push({
      id: p.id,
      x: ax,
      y: py,
      side,
      label,
      labelX: side === "WEST" ? px + 12 : px - 8,
      labelY: py,
      anchor: side === "WEST" ? "start" : "end",
      lead,
      bubble,
      clock,
    });
  };
  incoming.forEach((p, i) => make(p, i, incoming.length, "WEST"));
  outgoing.forEach((p, i) => make(p, i, outgoing.length, "EAST"));
  controls.forEach((p, i) => {
    const px = x + (w * (i + 1)) / (controls.length + 1);
    const py = y + h;
    const contact =
      symbol === "mux" || symbol === "encoder"
        ? py - (12 * (px - x)) / w
        : symbol === "decoder" || symbol === "demux"
          ? py - 12 * (1 - (px - x) / w)
          : symbol === "buffer" || symbol === "not"
            ? py - ((h / 2) * (px - x)) / (w - 8)
            : py;
    const inverted = p.display?.polarity === false;
    pins.push({
      id: p.id,
      x: px,
      y: height,
      side: "SOUTH",
      label:
        shortName(pinLabel(p), 14) +
        (p.display?.role !== "select" && p.display?.polarity == null
          ? " ?"
          : ""),
      labelX: px,
      labelY: contact - 12,
      anchor: "middle",
      lead: `M${px},${height} V${contact + (inverted ? 8 : 0)}`,
      bubble: inverted ? [px, contact + 4] : undefined,
    });
  });
  if (symbol === "compound") {
    const output = pins.find((p) => p.side === "EAST");
    const inputs = new Map(
      pins
        .filter((p) => p.side === "WEST")
        .map((p) => [ports.find((port) => port.id === p.id)?.display?.name, p]),
    );
    const andFirst = title.startsWith("a");
    const inverted = title.endsWith("i");
    const glyph = (gx: number, gy: number, and: boolean) => {
      paths.push({
        d: and
          ? `M${gx},${gy - 10} H${gx + 10} Q${gx + 34},${gy} ${gx + 10},${gy + 10} H${gx} Z`
          : `M${gx},${gy - 10} Q${gx + 16},${gy - 10} ${gx + 28},${gy} Q${gx + 16},${gy + 10} ${gx},${gy + 10} Q${gx + 9},${gy} ${gx},${gy - 10} Z`,
        fill: true,
      });
    };
    if (output) {
      const secondX = x + w - pinTextWidth(outgoing) - 57;
      glyph(secondX, output.y, !andFirst);
      const line = (d: string) => paths.push({ d, fill: false });
      const group = (first: string, second: string, inputY: number) => {
        const a = inputs.get(first) ?? inputs.get(first === "A1" ? "A" : "C"),
          b = inputs.get(second) ?? inputs.get(second === "A2" ? "B" : "D");
        if (!a) return;
        if (b) {
          const center = (a.y + b.y) / 2;
          const firstX = x + pinTextWidth(incoming) + 36;
          const startX = x + pinTextWidth(incoming) + 20;
          glyph(firstX, center, andFirst);
          line(
            `M${startX},${a.y} H${firstX - 6} V${center - 5} H${firstX} M${startX},${b.y} H${firstX - 6} V${center + 5} H${firstX}`,
          );
          line(
            `M${firstX + 28},${center} H${secondX - 8} V${inputY} H${secondX}`,
          );
        } else
          line(
            `M${x + pinTextWidth(incoming) + 20},${a.y} H${secondX - 12} V${inputY} H${secondX}`,
          );
      };
      group("A1", "A2", output.y - 5);
      group("B1", "B2", output.y + 5);
      if (inverted)
        paths.push({
          d: `M${secondX + 28},${output.y} a4,4 0 1,0 8,0 a4,4 0 1,0 -8,0`,
          fill: true,
        });
      line(
        `M${secondX + (inverted ? 36 : 28)},${output.y} H${x + w - pinTextWidth(outgoing) - 16}`,
      );
    }
  }
  if (node.display?.annotations.length)
    texts.push({
      x: width / 2,
      y: 33,
      text: shortName(node.display.annotations.join(" · "), 36),
      anchor: "middle",
      secondary: true,
    });
  return { width, height, paths, texts, pins, symbol };
}
