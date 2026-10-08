import type { ElkNode, ElkExtendedEdge, ElkPoint } from "elkjs";
import type { Graph, Node, Port, Edge } from "./types";
import {
  boundaryDirection,
  pinLabel,
  shortName,
  symbolGeometry,
} from "./schematic-symbols";

export interface ControlConnector {
  port_id: string;
  edge_id: string;
  label: string;
}
export interface RoutedWire {
  id: string;
  edge_id: string;
  signal_ids: string[];
  width: number;
  semantics: Edge["semantics"];
  /** Segments of a bus narrow where only a slice continues. */
  paths: { d: string; width: number }[];
  junctions: ElkPoint[];
  labels: { x: number; y: number; text: string }[];
}
export interface LayoutView {
  graph: ElkNode;
  render_nodes: Node[];
  /** Original net of every routed ELK edge. */
  edge_map: Record<string, string>;
  connectors: ControlConnector[];
  /** Wire each routed ELK edge is drawn in: a net, or the output of one join. */
  route_groups: Record<string, string>;
  edge_widths: Record<string, number>;
  wire_signal_ids: Record<string, string[]>;
  wires: RoutedWire[];
}

/** Length of the stub a control connector draws beside its pin. */
export const CONNECTOR = 18;

function syntheticDisplay(symbol: string, title: string) {
  return {
    symbol,
    title,
    annotations: [],
    members: [],
    internal_signal_ids: [],
    physical_only: false,
  };
}

/**
 * Order nodes so every wire runs forward except the outputs of registers,
 * latches and memories that close a loop. ELK then reverses exactly those
 * edges, which places a register after the logic computing its input.
 */
function dataflowOrder(
  count: number,
  links: [number, number][],
  sequential: Set<number>,
): number[] {
  const next: number[][] = Array.from({ length: count }, () => []);
  for (const [from, to] of links) if (from !== to) next[from]?.push(to);
  // Tarjan's strongly connected components, iterative for deep chains.
  const component = new Array<number>(count).fill(-1);
  const index = new Array<number>(count).fill(-1);
  const low = new Array<number>(count).fill(0);
  const onStack = new Array<boolean>(count).fill(false);
  const stack: number[] = [];
  let visited = 0,
    components = 0;
  for (let root = 0; root < count; root++) {
    if (index[root] !== -1) continue;
    const work: [number, number][] = [[root, 0]];
    while (work.length) {
      const frame = work[work.length - 1];
      if (!frame) break;
      const [node, edge] = frame;
      if (edge === 0) {
        index[node] = low[node] = visited++;
        stack.push(node);
        onStack[node] = true;
      }
      const child = next[node]?.[edge];
      if (child !== undefined) {
        frame[1]++;
        if (index[child] === -1) work.push([child, 0]);
        else if (onStack[child])
          low[node] = Math.min(low[node] ?? 0, index[child] ?? 0);
        continue;
      }
      work.pop();
      const parent = work[work.length - 1]?.[0];
      if (parent !== undefined)
        low[parent] = Math.min(low[parent] ?? 0, low[node] ?? 0);
      if (low[node] === index[node]) {
        for (;;) {
          const member = stack.pop();
          if (member === undefined) break;
          onStack[member] = false;
          component[member] = components;
          if (member === node) break;
        }
        components++;
      }
    }
  }
  const forward: number[][] = Array.from({ length: count }, () => []);
  const waiting = new Array<number>(count).fill(0);
  for (let from = 0; from < count; from++)
    for (const to of next[from] ?? []) {
      if (sequential.has(from) && component[from] === component[to]) continue;
      forward[from]?.push(to);
      waiting[to] = (waiting[to] ?? 0) + 1;
    }
  const order: number[] = [];
  const placed = new Array<boolean>(count).fill(false);
  while (order.length < count) {
    // The earliest ready node; a remaining combinational loop starts at its
    // earliest member.
    let pick = -1;
    for (let node = 0; node < count; node++) {
      if (placed[node]) continue;
      if (waiting[node] === 0) {
        pick = node;
        break;
      }
      if (pick === -1) pick = node;
    }
    placed[pick] = true;
    order.push(pick);
    for (const to of forward[pick] ?? [])
      waiting[to] = Math.max(0, (waiting[to] ?? 0) - 1);
  }
  return order;
}

/** Layout-only helpers retain original net IDs and never create waveform identities. */
export function prepareLayout(
  graph: Graph,
  fullControlWiring = false,
): LayoutView {
  const visible: Node[] = [...graph.nodes];
  const ports = new Map<string, { node: Node; port: Port }>();
  for (const node of visible)
    for (const port of node.ports) ports.set(port.id, { node, port });
  const connectors: ControlConnector[] = [];
  const routes: Edge[] = [];
  for (const incoming of graph.edges) {
    const original = {
      ...incoming,
      sources: incoming.sources.filter(
        (id) => ports.get(id)?.port.display?.role !== "power",
      ),
      targets: incoming.targets.filter(
        (id) => ports.get(id)?.port.display?.role !== "power",
      ),
    };
    if (!original.sources.length || !original.targets.length) continue;
    const control =
      !fullControlWiring &&
      original.semantics !== "dependency" &&
      original.semantics !== "control_flow" &&
      original.sources.length === 1 &&
      original.bits?.length === 1 &&
      original.targets.every((id) =>
        ["clock", "reset"].includes(ports.get(id)?.port.display?.role ?? ""),
      );
    if (control) {
      for (const id of new Set([...original.sources, ...original.targets]))
        connectors.push({
          port_id: id,
          edge_id: original.id,
          label: shortName(
            original.label ||
              graph.signals
                .find((signal) => original.signal_ids.includes(signal.id))
                ?.path.at(-1) ||
              "control",
            20,
          ),
        });
      continue;
    }
    routes.push(original);
  }
  const edgeMap: Record<string, string> = {};
  const routeGroups: Record<string, string> = {};
  const edgeWidths: Record<string, number> = {};
  const wireSignals: Record<string, string[]> = {};
  const edges: ElkExtendedEdge[] = [];
  const add = (
    original: Edge,
    wire: string,
    source: string,
    target: string,
    width: number,
  ) => {
    if (source === target) return;
    const id = `${original.id}:route:${edges.length}`;
    // Only dependency and control-flow edges reserve room for a name; net
    // names are drawn where a route already leaves space.
    const named =
      original.label &&
      original.semantics &&
      original.semantics !== "electrical" &&
      !Object.values(edgeMap).includes(original.id);
    edgeMap[id] = original.id;
    routeGroups[id] = wire;
    edgeWidths[id] = width;
    edges.push({
      id,
      sources: [source],
      targets: [target],
      labels: named
        ? [
            {
              text: shortName(original.label, 28),
              width: Math.min(204, original.label.length * 7),
              height: 14,
            },
          ]
        : [],
    });
  };
  // A pin assembled from several sources gets a visible join. Its inputs list
  // the pin's ranges from the most significant down, like a concatenation.
  const joins = new Map<string, string[]>();
  const routed = new Map(routes.map((edge) => [edge.id, edge]));
  for (const { node, port } of [...ports.values()]) {
    const feeds = port.feeds ?? [];
    const original = feeds
      .flatMap((feed) => (feed.kind === "net" ? [routed.get(feed.edge)] : []))
      .find((edge) => edge);
    if (feeds.length < 2 || !original) continue;
    const id = `bus:${port.id}`;
    const width = feeds.reduce((sum, feed) => sum + feed.width, 0);
    const range = port.display?.range;
    const declared = (position: number) =>
      range
        ? range[0] >= range[1]
          ? range[1] + position
          : range[1] - position
        : position;
    let position = 0;
    const inputs = feeds.map((feed, i): Port => {
      const low = declared(position),
        high = declared(position + feed.width - 1);
      position += feed.width;
      return {
        id: `${id}:slice:${i}`,
        label: feed.width > 1 ? `[${high}:${low}]` : `[${low}]`,
        direction: "input",
        signal_ids: port.signal_ids,
        display: { name: "", width: feed.width, bits: [], role: "data" },
        feeds: [feed],
      };
    });
    const whole: Port = {
      id: `${id}:whole`,
      label: "",
      direction: "output",
      signal_ids: port.signal_ids,
      display: { name: "", width, bits: [], role: "data" },
    };
    const join: Node = {
      id,
      label: `${node.label} ${pinLabel(port)}`,
      kind: "bus connector",
      ports: [whole, ...inputs.reverse()],
      display: syntheticDisplay("bus_split", ""),
    };
    visible.push(join);
    for (const p of join.ports) ports.set(p.id, { node: join, port: p });
    joins.set(
      port.id,
      feeds.map((_, i) => `${id}:slice:${i}`),
    );
    wireSignals[id] = port.signal_ids;
    add(original, id, whole.id, port.id, width);
  }
  for (const route of routes) {
    const sources = [...new Set(route.sources)];
    const targets = [...new Set(route.targets)].filter(
      (id) => !sources.includes(id),
    );
    wireSignals[route.id] = route.signal_ids;
    const width = route.bits?.length ?? 1;
    // Each load is wired once per run it takes from this net.
    const taps = (target: string): [string, number][] => {
      const feeds = ports.get(target)?.port.feeds ?? [];
      const joined = joins.get(target);
      const taken = feeds.flatMap((feed, i): [string, number][] =>
        feed.kind === "net" && feed.edge === route.id
          ? [[joined?.[i] ?? target, feed.width]]
          : [],
      );
      return taken.length ? taken : [[target, width]];
    };
    if (
      sources.length > 1 ||
      sources.some((id) => ports.get(id)?.port.direction === "inout")
    ) {
      const id = `junction:${route.id}`;
      const input = `${id}:in`,
        output = `${id}:out`;
      const junction: Node = {
        id,
        label: "",
        kind: "net junction",
        ports: [
          {
            id: input,
            label: "",
            direction: "input",
            signal_ids: route.signal_ids,
          },
          {
            id: output,
            label: "",
            direction: "output",
            signal_ids: route.signal_ids,
          },
        ],
        display: syntheticDisplay("junction", ""),
      };
      visible.push(junction);
      for (const p of junction.ports)
        ports.set(p.id, { node: junction, port: p });
      // A bidirectional pin joins the net once. Boundary pads sit in the last
      // layer, so they are reached from the junction like any load.
      for (const source of sources) {
        const owner = ports.get(source)?.node;
        if (owner?.kind === "port" && boundaryDirection(owner) !== "input")
          add(route, route.id, output, source, width);
        else add(route, route.id, source, input, width);
      }
      for (const target of targets)
        for (const [pin, taken] of taps(target))
          add(route, route.id, output, pin, taken);
    } else {
      const source = sources[0];
      if (!source) continue;
      for (const target of targets)
        for (const [pin, taken] of taps(target))
          add(route, route.id, source, pin, taken);
    }
  }
  // A boundary port already shows the name its connector would repeat.
  const stubs = new Map(
    connectors.map((connector) => [
      connector.port_id,
      CONNECTOR +
        (ports.get(connector.port_id)?.node.kind === "port"
          ? 0
          : shortName(connector.label, 18).length * 6),
    ]),
  );
  const children = visible.map((node): ElkNode => {
    const geometry = symbolGeometry(node);
    const side: Record<string, string> =
      node.kind === "port"
        ? boundaryDirection(node) === "input"
          ? {
              "elk.layered.layering.layerConstraint": "FIRST_SEPARATE",
              "elk.alignment": "RIGHT",
            }
          : {
              "elk.layered.layering.layerConstraint": "LAST_SEPARATE",
              "elk.alignment": "LEFT",
            }
        : {};
    return {
      id: node.id,
      width: geometry.width,
      height: geometry.height,
      layoutOptions: { "elk.portConstraints": "FIXED_POS", ...side },
      // A port's box covers what is drawn outside the symbol, so ELK keeps
      // neighbours clear of slice notes, constants and control connectors.
      ports: geometry.pins.map((pin) => {
        const horizontal = pin.side === "WEST" || pin.side === "EAST";
        // A connector above or below a symbol writes its name beside the stub.
        const stub = stubs.get(pin.id);
        const reach =
          pin.reach + (stub === undefined ? 0 : horizontal ? stub : CONNECTOR);
        return {
          id: pin.id,
          x:
            pin.side === "WEST"
              ? -reach
              : pin.side === "EAST"
                ? geometry.width
                : pin.x,
          y:
            pin.side === "NORTH"
              ? -reach
              : pin.side === "SOUTH"
                ? geometry.height
                : pin.y,
          width: horizontal ? reach : 0,
          height: horizontal ? 0 : reach,
          layoutOptions: { "elk.port.side": pin.side },
        };
      }),
    };
  });
  const position = new Map(visible.map((node, i) => [node.id, i]));
  const owner = (port: string) => position.get(ports.get(port)?.node.id ?? "");
  const order = dataflowOrder(
    visible.length,
    edges.flatMap((edge): [number, number][] => {
      const from = owner(edge.sources[0] ?? ""),
        to = owner(edge.targets[0] ?? "");
      return from === undefined || to === undefined ? [] : [[from, to]];
    }),
    new Set(
      visible.flatMap((node, i) =>
        ["register", "latch", "memory"].includes(node.display?.symbol ?? "")
          ? [i]
          : [],
      ),
    ),
  );
  const large = visible.length > 400;
  return {
    graph: {
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.edgeRouting": "ORTHOGONAL",
        "elk.spacing.nodeNode": "30",
        "elk.layered.spacing.nodeNodeBetweenLayers": "56",
        "elk.spacing.edgeNode": "12",
        "elk.layered.spacing.edgeEdgeBetweenLayers": "10",
        "elk.layered.cycleBreaking.strategy": "MODEL_ORDER",
        "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
        "elk.separateConnectedComponents": "false",
        "elk.randomSeed": "1",
        "elk.layered.thoroughness": large ? "1" : "7",
        "elk.layered.layering.strategy": large
          ? "LONGEST_PATH"
          : "NETWORK_SIMPLEX",
        "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      },
      children: order.flatMap((i) => children[i] ?? []),
      edges,
    },
    render_nodes: visible,
    edge_map: edgeMap,
    connectors,
    route_groups: routeGroups,
    edge_widths: edgeWidths,
    wire_signal_ids: wireSignals,
    wires: [],
  };
}

/** Turn ELK's per-load routes into one drawn wire per net or join output. */
export function finishLayout(view: LayoutView, graph: Graph): LayoutView {
  const originals = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const groups = new Map<string, ElkExtendedEdge[]>();
  for (const edge of view.graph.edges ?? []) {
    const key = view.route_groups[edge.id] ?? edge.id;
    const group = groups.get(key) ?? [];
    group.push(edge);
    groups.set(key, group);
  }
  const terminals = new Set<string>();
  const nodes = new Map(view.render_nodes.map((n) => [n.id, n]));
  const drivers = new Map(
    view.render_nodes.flatMap((n) => n.ports.map((p) => [p.id, n])),
  );
  const verticals = (view.graph.edges ?? []).flatMap((edge) =>
    (edge.sections ?? []).flatMap((section) => {
      const points = [
        section.startPoint,
        ...(section.bendPoints ?? []),
        section.endPoint,
      ];
      return points.flatMap((b, i): [number, number, number][] => {
        const a = points[i - 1];
        return a && a.x === b.x
          ? [[a.x, Math.min(a.y, b.y), Math.max(a.y, b.y)]]
          : [];
      });
    }),
  );
  for (const node of view.graph.children ?? []) {
    if (nodes.get(node.id)?.kind === "net junction") continue;
    for (const port of node.ports ?? [])
      terminals.add(
        pointKey({
          x: (node.x ?? 0) + (port.x ?? 0),
          y: (node.y ?? 0) + (port.y ?? 0),
        }),
      );
  }
  view.wires = [...groups.entries()].flatMap(([id, routes]): RoutedWire[] => {
    const first = routes[0];
    if (!first) return [];
    const edgeId = view.edge_map[first.id] ?? "";
    const original = originals.get(edgeId);
    if (!original) return [];
    const drawn = routes.flatMap((r) =>
      (r.sections ?? []).map((section) => ({
        points: [
          section.startPoint,
          ...(section.bendPoints ?? []),
          section.endPoint,
        ],
        width: view.edge_widths[r.id] ?? 1,
      })),
    );
    const width = Math.max(1, ...drawn.map((route) => route.width));
    const electrical =
      !original.semantics || original.semantics === "electrical";
    const normalized = electrical
      ? electricalPaths(
          drawn,
          terminals,
          routes.flatMap((r) => r.junctionPoints ?? []),
        )
      : {
          paths: drawn.map((route) => ({
            d: pathData(route.points),
            width: route.width,
          })),
          junctions: [],
        };
    // Dependency and control-flow names were placed by ELK. A net is named on
    // the straight run leaving its single driver, when that run has room, no
    // wire crosses the name and the driver does not already show it.
    const labels: RoutedWire["labels"] = routes.flatMap((r) =>
      (r.labels ?? []).map((label) => ({
        x: label.x ?? 0,
        y: (label.y ?? 0) + 11,
        text: label.text ?? "",
      })),
    );
    const [start, bend] = drawn[0]?.points ?? [];
    const driver = drivers.get(first.sources[0] ?? "");
    const name = original.label;
    if (
      electrical &&
      id === edgeId &&
      name &&
      start &&
      bend &&
      start.y === bend.y &&
      driver?.kind !== "port" &&
      driver?.display?.title !== name &&
      drawn.every(
        (route) =>
          route.points[0]?.x === start.x && route.points[0]?.y === start.y,
      ) &&
      Math.min(
        ...drawn.map((route) => (route.points[1]?.x ?? start.x) - start.x),
      ) >=
        name.length * 6 + 16 &&
      !verticals.some(
        ([x, top, bottom]) =>
          x > start.x &&
          x < start.x + name.length * 6 + 10 &&
          top < start.y &&
          bottom > start.y - 16,
      )
    )
      labels.push({ x: start.x + 6, y: start.y - 6, text: name });
    return [
      {
        id,
        edge_id: edgeId,
        signal_ids: view.wire_signal_ids[id] ?? original.signal_ids,
        width,
        semantics: original.semantics,
        ...normalized,
        labels,
      },
    ];
  });
  return view;
}
const rounded = (n: number) => Math.round(n * 100000) / 100000;
const pointKey = (p: ElkPoint) => `${rounded(p.x)},${rounded(p.y)}`;
const pathData = (points: ElkPoint[]) =>
  points.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" ");
type Interval = [number, number];
type Run = [number, number, number];

/** Union only routes of one authoritative net, never coincident foreign nets. */
function electricalPaths(
  routes: { points: ElkPoint[]; width: number }[],
  terminals: Set<string>,
  elkJunctions: ElkPoint[],
) {
  const horizontalRuns = new Map<number, Run[]>(),
    verticalRuns = new Map<number, Run[]>();
  const candidates = new Map<string, ElkPoint>();
  const candidate = (p: ElkPoint) =>
    candidates.set(pointKey(p), { x: rounded(p.x), y: rounded(p.y) });
  for (const { points, width } of routes) {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1],
        b = points[i];
      if (!a || !b) continue;
      const h = rounded(a.y) === rounded(b.y);
      if (!h && rounded(a.x) !== rounded(b.x))
        throw new Error("Electrical routing must be orthogonal");
      const map = h ? horizontalRuns : verticalRuns,
        key = rounded(h ? a.y : a.x);
      const list = map.get(key) ?? [];
      const start = rounded(h ? a.x : a.y),
        end = rounded(h ? b.x : b.y);
      if (start === end) continue;
      list.push([Math.min(start, end), Math.max(start, end), width]);
      map.set(key, list);
      candidate(a);
      candidate(b);
    }
  }
  // Coverage decides junctions; a shared stretch is drawn at its widest route.
  const horizontal = new Map<number, Interval[]>(),
    vertical = new Map<number, Interval[]>();
  const paths: { d: string; width: number }[] = [];
  for (const [runs, covered, h] of [
    [horizontalRuns, horizontal, true],
    [verticalRuns, vertical, false],
  ] as const)
    for (const [key, list] of runs) {
      list.sort((a, b) => a[0] - b[0]);
      const merged: Interval[] = [];
      for (const [from, to] of list) {
        const last = merged.at(-1);
        if (last && from <= last[1]) last[1] = Math.max(last[1], to);
        else merged.push([from, to]);
      }
      covered.set(key, merged);
      const cuts = [...new Set(list.flatMap(([from, to]) => [from, to]))].sort(
        (a, b) => a - b,
      );
      let open: Run | undefined;
      const emit = () => {
        if (open)
          paths.push({
            d: h
              ? `M${open[0]},${key} L${open[1]},${key}`
              : `M${key},${open[0]} L${key},${open[1]}`,
            width: open[2],
          });
        open = undefined;
      };
      for (let i = 1; i < cuts.length; i++) {
        const from = cuts[i - 1] ?? 0,
          to = cuts[i] ?? 0;
        const width = Math.max(
          0,
          ...list
            .filter((run) => run[0] <= from && run[1] >= to)
            .map((run) => run[2]),
        );
        if (open && width === open[2] && open[1] === from) open[1] = to;
        else {
          emit();
          if (width) open = [from, to, width];
        }
      }
      emit();
    }
  const directions = (list: Interval[] | undefined, value: number) => {
    if (!list) return 0;
    let low = 0,
      high = list.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if ((list[mid]?.[1] ?? -Infinity) < value) low = mid + 1;
      else high = mid;
    }
    const interval = list[low];
    if (!interval || interval[0] > value) return 0;
    return Number(interval[0] < value) + Number(interval[1] > value);
  };
  const xs = [...vertical.keys()].sort((a, b) => a - b);
  for (const [y, intervals] of horizontal)
    for (const [a, b] of intervals) {
      let low = 0,
        high = xs.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if ((xs[mid] ?? Infinity) < a) low = mid + 1;
        else high = mid;
      }
      for (let i = low; i < xs.length; i++) {
        const x = xs[i];
        if (x === undefined || x > b) break;
        if (directions(vertical.get(x), y)) candidate({ x, y });
      }
    }
  // ELK can provide interior crossings; only accept points with three or more
  // incident directions in this net's normalized routes.
  elkJunctions.forEach(candidate);
  const junctions = [...candidates.values()].filter(
    (p) =>
      !terminals.has(pointKey(p)) &&
      directions(horizontal.get(p.y), p.x) +
        directions(vertical.get(p.x), p.y) >=
        3,
  );
  return { paths, junctions };
}
