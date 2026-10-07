import { describe, it, expect } from "vitest";
import ELK from "elkjs/lib/elk.bundled.js";
import { prepareLayout, finishLayout } from "./schematic-layout";
import { symbolGeometry } from "./schematic-symbols";
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
  display: { name: id, width: bits.length, bits, role, polarity: true },
});
const node = (id: string, symbol: string, ports: Port[]): Node => ({
  id,
  label: id,
  kind: symbol,
  ports,
  display: {
    symbol,
    title: symbol,
    annotations: [],
    members: [],
    internal_signal_ids: [],
    physical_only: false,
  },
});
const graph = (nodes: Node[], edges: Graph["edges"]): Graph => ({
  nodes,
  edges,
  signals: [],
  total_cells: nodes.length,
  truncated: false,
});
describe("schematic geometry and routing", () => {
  it("uses shape-specific anchors including mux selectors and clock polarity", () => {
    const mux = node("mux", "mux", [
      pin("a", "input"),
      pin("b", "input"),
      pin("s", "input", "select"),
      pin("y", "output"),
    ]);
    const shape = symbolGeometry(mux);
    expect(shape.pins.find((p) => p.id === "s")?.side).toBe("SOUTH");
    expect(shape.paths[0]?.d).not.toBe(
      symbolGeometry(node("and", "and", mux.ports)).paths[0]?.d,
    );
    const clock = pin("clk", "input", "clock");
    if (clock.display) clock.display.polarity = false;
    const ff = symbolGeometry(
      node("ff", "register", [pin("d", "input"), clock, pin("q", "output")]),
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
  it("shows partial bus correspondence and retains separate original signal IDs", () => {
    const bus = node("bus", "module", [
      pin("bus:y", "output", "data", [2, 3, 4, 5]),
    ]);
    const sink = node("sink", "module", [
      pin("sink:a", "input", "data", [2, 3]),
      pin("sink:b", "input", "data", [4, 5]),
    ]);
    const prepared = prepareLayout(
      graph(
        [bus, sink],
        [
          {
            id: "low",
            sources: ["bus:y"],
            targets: ["sink:a"],
            signal_ids: ["low"],
            label: "low",
            bits: [2, 3],
          },
          {
            id: "high",
            sources: ["bus:y"],
            targets: ["sink:b"],
            signal_ids: ["high"],
            label: "high",
            bits: [4, 5],
          },
        ],
      ),
    );
    const split = prepared.render_nodes.find((n) => n.kind === "bus connector");
    expect(split?.ports.map((p) => p.label)).toEqual(["/4", "[1:0]", "[3:2]"]);
    expect(new Set(Object.values(prepared.edge_map))).toEqual(
      new Set(["low", "high"]),
    );
  });
  it("keeps power details out of logical routes and constant vectors local", async () => {
    const c = node("c", "constant", [pin("c:y", "output", "data", ["0"])]);
    c.kind = "constant";
    const rail = node("rail", "port", [pin("rail:y", "output")]);
    const sink = node("sink", "module", [
      pin("sink:a", "input", "data", ["0", "0", "0", "0"]),
      pin("sink:p", "input", "power"),
    ]);
    const prepared = prepareLayout(
      graph(
        [c, rail, sink],
        [
          {
            id: "constant",
            sources: ["c:y"],
            targets: ["sink:a"],
            signal_ids: [],
            label: "0",
            bits: ["0"],
          },
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
    expect(
      prepared.render_nodes
        .filter((n) => n.kind === "constant")
        .map((n) => n.label),
    ).toEqual(["4'b0000"]);
    expect(Object.values(prepared.edge_map)).not.toContain("power");
    expect(prepared.graph.edges).toHaveLength(1);
    expect(
      (await new ELK().layout(prepared.graph)).edges?.[0]?.sections,
    ).toHaveLength(1);
  });
  it("keeps every symbol terminal on its routed border and labels on the pin centerline", async () => {
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
      "process",
      "module",
      "unknown",
    ]) {
      const n = node(symbol, symbol, [
        pin(`${symbol}:long_data_input`, "input"),
        pin(`${symbol}:clock`, "input", "clock"),
        pin(`${symbol}:reset_active_low`, "input", "reset"),
        pin(`${symbol}:enable`, "input", "enable"),
        pin(`${symbol}:result`, "output"),
      ]);
      const geometry = symbolGeometry(n);
      const g = graph([n], []);
      const view = prepareLayout(g, true);
      view.graph = await new ELK().layout(view.graph);
      const actual = view.graph.children?.[0]?.ports;
      for (const anchor of geometry.pins) {
        const routed = actual?.find((p) => p.id === anchor.id);
        expect(routed?.x).toBeCloseTo(anchor.x, 8);
        expect(routed?.y).toBeCloseTo(anchor.y, 8);
        if (anchor.side === "WEST" || anchor.side === "EAST")
          expect(anchor.labelY).toBe(anchor.y);
        if (anchor.side === "SOUTH") {
          expect(anchor.y).toBe(geometry.height);
          expect(anchor.labelY).toBeLessThan(anchor.y - 8);
        }
      }
    }
  });
  it("aligns compact ordered boundary columns even when every port is disconnected", async () => {
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
    expect(placed.get("z")?.y).toBeLessThan(placed.get("a")?.y ?? 0);
    expect(view.graph.children?.map((n) => n.id)).toEqual(
      nodes.map((n) => n.id),
    );
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
    const edge = g.edges[0];
    if (edge) edge.semantics = "dependency";
    finishLayout(view, g);
    expect(view.wires.find((w) => w.edge_id === "net")?.junctions).toEqual([]);
  });
});
