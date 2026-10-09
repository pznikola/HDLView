import { describe, it, expect } from "vitest";
import ELK from "elkjs/lib/elk.bundled.js";
import {
  prepareLayout,
  finishLayout,
  type LayoutView,
} from "./schematic-layout";
import { boundaryDirection, symbolGeometry } from "./schematic-symbols";
import type { Graph, Node, Port, PinDisplay } from "./types";
const pin = (
  id: string,
  direction: string,
  role: PinDisplay["role"] = "data",
  bits: (number | string)[] = [2],
): Port => ({
  id,
  label: id,
  direction,
  signal_ids: [`signal:${id}`],
  display: {
    name: id,
    width: bits.length,
    bits,
    role,
    polarity: true,
    asynchronous: false,
  },
});
const node = (id: string, symbol: string, ports: Port[]): Node => ({
  id,
  label: id,
  kind: symbol,
  // A boundary port faces inward: a module input drives the schematic.
  ports:
    symbol === "port"
      ? ports.map((p) => ({
          ...p,
          display: {
            ...p.display,
            declared_direction: p.direction === "output" ? "input" : "output",
          },
        }))
      : ports,
  child_scope: null,
  source: null,
  display: {
    symbol,
    title: symbol,
    annotations: [],
    members: [],
    internal_signal_ids: [],
  },
});
const graph = (nodes: Node[], edges: Graph["edges"]): Graph => ({
  nodes,
  edges,
  signals: [],
  total_cells: nodes.length,
  truncated: false,
  hidden_physical_cells: 0,
  omitted_cells: 0,
});
const net = (id: string, sources: string[], targets: string[]) => ({
  id,
  sources,
  targets,
  signal_ids: [id],
  label: id,
  bits: [2],
});
const input = (id: string) => node(id, "port", [pin(`${id}:p`, "output")]);
const output = (id: string) => node(id, "port", [pin(`${id}:p`, "input")]);
const register = (id: string) =>
  node(id, "register", [
    pin(`${id}:d`, "input"),
    pin(`${id}:clk`, "input", "clock"),
    pin(`${id}:q`, "output"),
  ]);
const gate = (id: string, symbol: string) =>
  node(id, symbol, [
    pin(`${id}:a`, "input"),
    pin(`${id}:b`, "input"),
    pin(`${id}:y`, "output"),
  ]);
async function layout(g: Graph): Promise<LayoutView> {
  const view = prepareLayout(g, true);
  view.graph = await new ELK().layout(view.graph);
  return finishLayout(view, g);
}
/** Readability relations that hold for any netlist; none depends on a coordinate value. */
function violations(view: LayoutView, g: Graph): string[] {
  const found: string[] = [];
  const placed = view.graph.children ?? [];
  const boxes = placed
    .filter((n) => n.width && n.height)
    .map((n) => ({
      id: n.id,
      left: n.x ?? 0,
      top: n.y ?? 0,
      right: (n.x ?? 0) + (n.width ?? 0),
      bottom: (n.y ?? 0) + (n.height ?? 0),
    }));
  boxes.forEach((a, i) => {
    for (const b of boxes.slice(i + 1))
      if (
        a.left < b.right &&
        b.left < a.right &&
        a.top < b.bottom &&
        b.top < a.bottom
      )
        found.push(`${a.id} overlaps ${b.id}`);
  });
  const owner = new Map<string, string>();
  for (const n of placed) for (const p of n.ports ?? []) owner.set(p.id, n.id);
  for (const wire of view.wires) {
    const own = new Set(
      (view.graph.edges ?? [])
        .filter((e) => view.edge_map[e.id] === wire.edge_id)
        .flatMap((e) => [...e.sources, ...e.targets])
        .map((id) => owner.get(id)),
    );
    for (const path of wire.paths) {
      const points = [...path.d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [
        Number(m[1]),
        Number(m[2]),
      ]);
      for (const [i, b] of points.entries()) {
        const a = points[i - 1];
        if (!a) continue;
        const [ax = 0, ay = 0] = a,
          [bx = 0, by = 0] = b;
        for (const box of boxes)
          if (
            !own.has(box.id) &&
            Math.min(ax, bx) < box.right &&
            Math.max(ax, bx) > box.left &&
            Math.min(ay, by) < box.bottom &&
            Math.max(ay, by) > box.top
          )
            found.push(`${wire.edge_id} passes through ${box.id}`);
      }
    }
  }
  const contacts = { input: new Set<number>(), output: new Set<number>() };
  for (const n of g.nodes.filter((n) => n.kind === "port")) {
    const at = placed.find((p) => p.id === n.id);
    contacts[boundaryDirection(n) === "input" ? "input" : "output"].add(
      (at?.x ?? 0) + (at?.ports?.[0]?.x ?? 0),
    );
  }
  const symbol = (id: string | undefined) =>
    g.nodes.find((n) => n.id === id)?.display?.symbol;
  for (const edge of g.edges)
    for (const target of edge.targets) {
      const sink = owner.get(target),
        driver = owner.get(edge.sources[0] ?? "");
      if (
        symbol(sink) !== "register" ||
        ["register", "port", undefined].includes(symbol(driver)) ||
        target.endsWith(":clk")
      )
        continue;
      const left = (id: string | undefined) =>
        boxes.find((box) => box.id === id)?.left ?? 0;
      if (left(sink) <= left(driver))
        found.push(
          `${sink} is not right of ${driver}, which computes its input`,
        );
    }
  if (contacts.input.size > 1) found.push("input terminals are not aligned");
  if (contacts.output.size > 1) found.push("output terminals are not aligned");
  if (Math.max(...contacts.input) >= Math.min(...contacts.output))
    found.push("inputs are not left of outputs");
  return found;
}
const readable: Record<string, Graph> = {
  "an adder feeding a register with feedback": graph(
    [
      input("clk"),
      input("step"),
      output("count"),
      gate("add", "operator"),
      register("reg"),
    ],
    [
      net("clk", ["clk:p"], ["reg:clk"]),
      net("step", ["step:p"], ["add:b"]),
      net("sum", ["add:y"], ["reg:d"]),
      net("count", ["reg:q"], ["add:a", "count:p"]),
    ],
  ),
  "a shift register with a self-loop and feedback gate": graph(
    [
      input("clk"),
      output("out"),
      gate("xor", "xor"),
      node("lfsr", "register", [
        pin("lfsr:shift", "input"),
        pin("lfsr:in", "input"),
        pin("lfsr:clk", "input", "clock"),
        pin("lfsr:q", "output"),
      ]),
    ],
    [
      net("clk", ["clk:p"], ["lfsr:clk"]),
      net("taps", ["lfsr:q"], ["lfsr:shift", "xor:a", "xor:b", "out:p"]),
      net("next", ["xor:y"], ["lfsr:in"]),
    ],
  ),
  "a two-register pipeline": graph(
    [
      input("clk"),
      input("a"),
      input("b"),
      output("out"),
      register("first"),
      gate("and", "and"),
      register("second"),
    ],
    [
      net("clk", ["clk:p"], ["first:clk", "second:clk"]),
      net("a", ["a:p"], ["first:d"]),
      net("staged", ["first:q"], ["and:a"]),
      net("b", ["b:p"], ["and:b"]),
      net("gated", ["and:y"], ["second:d"]),
      net("out", ["second:q"], ["out:p"]),
    ],
  ),
  "a case multiplexer": graph(
    [
      input("sel"),
      input("a"),
      input("b"),
      input("c"),
      output("y"),
      node("mux", "mux", [
        pin("mux:0", "input"),
        pin("mux:1", "input"),
        pin("mux:2", "input"),
        pin("mux:s", "input", "select"),
        pin("mux:y", "output"),
      ]),
    ],
    [
      net("sel", ["sel:p"], ["mux:s"]),
      net("a", ["a:p"], ["mux:0"]),
      net("b", ["b:p"], ["mux:1"]),
      net("c", ["c:p"], ["mux:2"]),
      net("y", ["mux:y"], ["y:p"]),
    ],
  ),
};
describe("schematic readability", () => {
  for (const [name, g] of Object.entries(readable))
    it(`lays out ${name} with registers after their logic and no overlaps, pierced symbols or ragged ports`, async () => {
      expect(violations(await layout(g), g)).toEqual([]);
    });
});
describe("schematic geometry and routing", () => {
  it("puts synchronous inputs on the left and only asynchronous controls above and below", () => {
    const mux = node("mux", "mux", [
      pin("a", "input"),
      pin("b", "input"),
      pin("s", "input", "select"),
      pin("y", "output"),
    ]);
    const shape = symbolGeometry(mux);
    const at = (id: string) => shape.pins.find((p) => p.id === id);
    expect(at("s")?.side).toBe("WEST");
    expect(at("s")?.y).toBeGreaterThan(at("b")?.y ?? 0);
    expect(shape.paths[0]?.d).not.toBe(
      symbolGeometry(node("and", "and", mux.ports)).paths[0]?.d,
    );
    const clock = pin("clk", "input", "clock");
    const clear = pin("clr", "input", "reset");
    const preset = pin("pre", "input", "set");
    for (const control of [clock, clear, preset])
      if (control.display) control.display.polarity = false;
    if (clear.display) clear.display.asynchronous = true;
    if (preset.display) preset.display.asynchronous = true;
    const ff = symbolGeometry(
      node("ff", "register", [
        pin("d", "input"),
        clock,
        pin("en", "input", "enable"),
        pin("srst", "input", "reset"),
        clear,
        preset,
        pin("q", "output"),
      ]),
    );
    const side = (id: string) => ff.pins.find((p) => p.id === id)?.side;
    expect(["d", "clk", "en", "srst"].map(side)).toEqual([
      "WEST",
      "WEST",
      "WEST",
      "WEST",
    ]);
    expect([side("clr"), side("pre"), side("q")]).toEqual([
      "SOUTH",
      "NORTH",
      "EAST",
    ]);
    // D and Q share a row, so a datapath runs straight through the register.
    expect(ff.pins.find((p) => p.id === "d")?.y).toBe(
      ff.pins.find((p) => p.id === "q")?.y,
    );
    expect(ff.pins.find((p) => p.id === "clk")?.clock).toBeTruthy();
    expect(ff.pins.find((p) => p.id === "clk")?.bubble).toBeTruthy();
    expect(
      ff.pins.every(
        (p) => p.x >= 0 && p.x <= ff.width && p.y >= 0 && p.y <= ff.height,
      ),
    ).toBe(true);
  });
  it("keeps exact net mappings through multi-driver junctions without Cartesian routes", async () => {
    const nodes = [
      node("a", "buffer", [pin("a:y", "output")]),
      node("b", "buffer", [pin("b:y", "output")]),
      node("c", "module", [pin("c:a", "input")]),
      node("d", "module", [pin("d:a", "input")]),
    ];
    const edge = {
      id: "net",
      sources: ["a:y", "b:y"],
      targets: ["c:a", "d:a"],
      signal_ids: ["signal"],
      label: "shared",
      bits: [2],
    };
    const prepared = prepareLayout(graph(nodes, [edge]));
    expect(
      prepared.render_nodes.filter((n) => n.kind === "net junction"),
    ).toHaveLength(1);
    expect(prepared.graph.edges).toHaveLength(4);
    expect(new Set(Object.values(prepared.edge_map))).toEqual(new Set(["net"]));
    const result = await new ELK().layout(prepared.graph);
    expect(result.edges?.every((e) => e.sections?.length)).toBe(true);
    prepared.graph = result;
    const routed = finishLayout(prepared, graph(nodes, [edge]));
    expect(routed.wires).toHaveLength(1);
    expect(routed.wires[0]?.junctions.length ?? 0).toBeGreaterThan(0);
  });
  it("uses control connectors only for proven all-control nets", () => {
    const clk = node("clk", "port", [pin("clk:y", "output")]);
    const ff = node("ff", "register", [
      pin("ff:c", "input", "clock"),
      pin("ff:d", "input"),
      pin("ff:q", "output"),
    ]);
    const edge = {
      id: "clock",
      sources: ["clk:y"],
      targets: ["ff:c"],
      signal_ids: ["clk"],
      label: "clk",
      bits: [2],
    };
    const g = graph([clk, ff], [edge]);
    expect(prepareLayout(g).connectors).toHaveLength(2);
    expect(prepareLayout(g, true).connectors).toHaveLength(0);
    expect(
      prepareLayout(graph([clk, ff], [{ ...edge, targets: ["ff:c", "ff:d"] }]))
        .connectors,
    ).toHaveLength(0);
  });
  it("keeps a bus whole, taps slices where they are read and joins concatenations", async () => {
    const tapped = pin("low:a", "input", "data", [2, 3]);
    tapped.feeds = [{ kind: "net", edge: "bus", width: 2, label: "[1:0]" }];
    const whole = pin("all:a", "input", "data", [2, 3, 4, 5]);
    whole.feeds = [{ kind: "net", edge: "bus", width: 4, label: "" }];
    const joined = pin("cat:a", "input", "data", ["0", "0", 4, 5]);
    joined.feeds = [
      { kind: "constant", width: 2, label: "2'b00" },
      { kind: "net", edge: "bus", width: 2, label: "[3:2]" },
    ];
    const g = graph(
      [
        node("bus", "module", [pin("bus:y", "output", "data", [2, 3, 4, 5])]),
        node("low", "module", [tapped]),
        node("all", "module", [whole]),
        node("cat", "module", [joined]),
      ],
      [
        {
          id: "bus",
          sources: ["bus:y"],
          targets: ["low:a", "all:a", "cat:a"],
          signal_ids: ["bus"],
          label: "bus",
          bits: [2, 3, 4, 5],
        },
      ],
    );
    const view = await layout(g);
    expect(violations(view, g)).toEqual([]);
    const join = view.render_nodes.find((n) => n.kind === "bus connector");
    expect(join?.ports.map((p) => p.label)).toEqual(["", "[3:2]", "[1:0]"]);
    expect(new Set(Object.values(view.edge_map))).toEqual(new Set(["bus"]));
    // One drawn net carries every tap; it narrows where only a slice continues.
    const net = view.wires.find((w) => w.id === "bus");
    expect(net?.width).toBe(4);
    expect(new Set(net?.paths.map((path) => path.width))).toEqual(
      new Set([2, 4]),
    );
    expect(net?.junctions.length).toBeGreaterThan(0);
    expect(view.wires).toHaveLength(2);
    // The slice is named on the reading pin's lead, outside the symbol.
    const lead = symbolGeometry(g.nodes[1] ?? node("none", "module", []))
      .pins[0];
    expect(lead?.note?.text).toBe("[1:0]");
    expect(lead?.x).toBeLessThan(0);
  });
  it("draws constants on the pin and keeps power out of logical routes", () => {
    const tied = pin("sink:a", "input", "data", ["0", "0", "0", "0"]);
    tied.feeds = [{ kind: "constant", width: 4, label: "4'b0000" }];
    const rail = node("rail", "port", [pin("rail:y", "output")]);
    const sink = node("sink", "module", [
      tied,
      pin("sink:p", "input", "power"),
      pin("sink:off", "input", "unused"),
    ]);
    const prepared = prepareLayout(
      graph(
        [rail, sink],
        [
          {
            id: "power",
            sources: ["rail:y"],
            targets: ["sink:p"],
            signal_ids: ["rail"],
            label: "VDD",
            bits: [2],
          },
        ],
      ),
    );
    expect(prepared.render_nodes).toHaveLength(2);
    expect(prepared.graph.edges).toHaveLength(0);
    // Power and disabled controls are inspected, never drawn.
    expect(symbolGeometry(sink).pins.map((p) => p.id)).toEqual(["sink:a"]);
    const anchor = symbolGeometry(sink).pins.find((p) => p.id === "sink:a");
    expect(anchor?.note?.text).toBe("4'b0000");
    expect(anchor?.unwired).toBe(true);
    // ELK keeps neighbours clear of the literal drawn left of the symbol.
    const reserved = prepared.graph.children
      ?.find((n) => n.id === "sink")
      ?.ports?.find((p) => p.id === "sink:a");
    expect(reserved?.x).toBeLessThan(0);
    expect(reserved?.width).toBe(-(reserved?.x ?? 0));
  });
  it("wires a bidirectional pad and pin to their net once each", async () => {
    const g = graph(
      [
        node("pad", "port", [pin("pad:p", "inout")]),
        node("driver", "buffer", [
          pin("driver:a", "input"),
          pin("driver:y", "inout"),
        ]),
        node("reader", "module", [pin("reader:a", "input")]),
        input("data"),
      ],
      [
        net("data", ["data:p"], ["driver:a"]),
        {
          ...net(
            "io",
            ["driver:y", "pad:p"],
            ["driver:y", "pad:p", "reader:a"],
          ),
        },
      ],
    );
    const view = await layout(g);
    expect(violations(view, g)).toEqual([]);
    expect(
      (view.graph.edges ?? []).filter((e) => view.edge_map[e.id] === "io"),
    ).toHaveLength(3);
    expect(view.wires.filter((w) => w.edge_id === "io")).toHaveLength(1);
  });
  it("routes wires to every symbol's drawn terminals on all four sides", async () => {
    for (const symbol of [
      "and",
      "nand",
      "or",
      "xor",
      "buffer",
      "not",
      "mux",
      "demux",
      "register",
      "latch",
      "operator",
      "memory",
      "module",
      "unknown",
    ]) {
      const sliced = pin(`${symbol}:data`, "input", "data", [2, 3]);
      sliced.feeds = [{ kind: "net", edge: "bus", width: 2, label: "[3:2]" }];
      const clear = pin(`${symbol}:clear`, "input", "reset");
      const preset = pin(`${symbol}:preset`, "input", "set");
      if (clear.display) clear.display.asynchronous = true;
      if (preset.display) preset.display.asynchronous = true;
      const n = node(symbol, symbol, [
        sliced,
        pin(`${symbol}:clock`, "input", "clock"),
        pin(`${symbol}:enable`, "input", "enable"),
        clear,
        preset,
        pin(`${symbol}:result`, "output", "data", [4, 5, 6, 7]),
      ]);
      const geometry = symbolGeometry(n);
      const view = prepareLayout(graph([n], []), true);
      view.graph = await new ELK().layout(view.graph);
      const actual = view.graph.children?.[0]?.ports;
      for (const anchor of geometry.pins) {
        // ELK ends a wire on the outer edge of the port's reserved box.
        const routed = actual?.find((p) => p.id === anchor.id);
        expect(
          (routed?.x ?? 0) +
            (anchor.side === "EAST" ? (routed?.width ?? 0) : 0),
        ).toBeCloseTo(anchor.x, 8);
        expect(
          (routed?.y ?? 0) +
            (anchor.side === "SOUTH" ? (routed?.height ?? 0) : 0),
        ).toBeCloseTo(anchor.y, 8);
        if (anchor.side === "WEST" || anchor.side === "EAST")
          expect(anchor.labelY).toBe(anchor.y);
        if (anchor.side === "SOUTH") expect(anchor.y).toBe(geometry.height);
        if (anchor.side === "NORTH") expect(anchor.y).toBe(0);
      }
      // A buffer takes every control through the lower edge of its triangle.
      expect(new Set(geometry.pins.map((p) => p.side))).toEqual(
        new Set(
          symbol === "buffer" || symbol === "not"
            ? ["WEST", "EAST", "SOUTH"]
            : ["WEST", "EAST", "SOUTH", "NORTH"],
        ),
      );
    }
  });
  it("aligns boundary ports per side even when every port is disconnected", async () => {
    const nodes = [
      node("z", "port", [pin("z:p", "output")]),
      node("a", "port", [pin("a:p", "output")]),
      node("out", "port", [pin("out:p", "input")]),
      node("pad", "port", [pin("pad:p", "inout")]),
    ];
    const g = graph(nodes, []),
      view = prepareLayout(g);
    view.graph = await new ELK().layout(view.graph);
    finishLayout(view, g);
    const placed = new Map(view.graph.children?.map((n) => [n.id, n]));
    const contactX = (id: string) =>
      (placed.get(id)?.x ?? 0) + (placed.get(id)?.ports?.[0]?.x ?? 0);
    expect(contactX("z")).toBe(contactX("a"));
    expect(contactX("out")).toBe(contactX("pad"));
    expect(contactX("z")).toBeLessThan(contactX("out"));
    expect(
      symbolGeometry(nodes[0] ?? node("fallback", "port", [])).height,
    ).toBe(32);
    const bus = node("bits", "port", [
      pin("bits[7]", "output"),
      pin("bits[6]", "output"),
    ]);
    expect(symbolGeometry(bus).pins.map((p) => p.label)).toEqual([
      "bits[7]",
      "bits[6]",
    ]);
  });
  it("deduplicates shared trunks and dots actual branches without joining foreign crossings", () => {
    const g = graph(
      [
        node("a", "buffer", [pin("a:p", "output")]),
        node("b", "module", [pin("b:p", "input")]),
        node("c", "module", [pin("c:p", "input")]),
      ],
      [
        {
          id: "net",
          sources: ["a:p"],
          targets: ["b:p", "c:p"],
          signal_ids: ["n"],
          bits: [2],
          label: "n",
        },
        {
          id: "foreign",
          sources: ["a:p"],
          targets: ["b:p"],
          signal_ids: ["other"],
          bits: [3],
          label: "other",
        },
      ],
    );
    const view = prepareLayout(g, true);
    view.graph.children = [];
    for (const [i, edge] of (view.graph.edges ?? []).entries())
      edge.sections = [
        {
          id: edge.id + ":s",
          startPoint: { x: 0, y: i === 2 ? 10 : 0 },
          bendPoints: [{ x: 20, y: i === 2 ? 10 : 0 }],
          endPoint: { x: 20, y: i === 0 ? 20 : -20 },
        },
      ];
    finishLayout(view, g);
    const net = view.wires.find((w) => w.edge_id === "net");
    expect(net?.junctions).toEqual([{ x: 20, y: 0 }]);
    expect(net?.paths).toHaveLength(2);
    expect(view.wires.find((w) => w.edge_id === "foreign")?.junctions).toEqual(
      [],
    );
    expect(net?.signal_ids).toEqual(["n"]);
  });
});
