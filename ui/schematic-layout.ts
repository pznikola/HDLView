import type { ElkNode, ElkExtendedEdge, ElkPoint, ElkLabel } from "elkjs";
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
  paths: string[];
  junctions: ElkPoint[];
  labels: ElkLabel[];
}
export interface LayoutView {
  graph: ElkNode;
  render_nodes: Node[];
  edge_map: Record<string, string>;
  edge_signal_ids: Record<string, string[]>;
  connectors: ControlConnector[];
  columns: { id: string; children: ElkNode[] }[];
  route_groups: Record<string, string>;
  edge_widths: Record<string, number>;
  wires: RoutedWire[];
}

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

/** Layout-only helpers retain original net IDs and never create waveform identities. */
export function prepareLayout(
  graph: Graph,
  fullControlWiring = false,
): LayoutView {
  const nodes: Node[] = [...graph.nodes];
  const ports = new Map<string, { node: Node; port: Port }>();
  for (const node of nodes)
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
      original.targets.length > 0 &&
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
    const constantSource =
      original.sources.length === 1
        ? ports.get(original.sources[0] ?? "")
        : undefined;
    if (
      constantSource?.node.kind === "constant" &&
      original.targets.length > 1
    ) {
      const byNode = new Map<string, string[]>();
      for (const target of original.targets) {
        const owner = ports.get(target)?.node.id;
        if (!owner) continue;
        const list = byNode.get(owner) ?? [];
        list.push(target);
        byNode.set(owner, list);
      }
      for (const [owner, targets] of byNode) {
        const id = `${constantSource.node.id}:local:${owner}`;
        const clone: Node = {
          ...constantSource.node,
          id,
          ports: constantSource.node.ports.map((p) => ({
            ...p,
            id: `${id}:${p.id}`,
          })),
        };
        nodes.push(clone);
        for (const port of clone.ports)
          ports.set(port.id, { node: clone, port });
        routes.push({
          ...original,
          sources: clone.ports.map((p) => p.id),
          targets,
        });
      }
    } else
      routes.push({
        ...original,
        sources: [...original.sources],
        targets: [...original.targets],
      });
  }
  // Collect repeated constant bits at a consumer into one ordered literal. This
  // avoids turning e.g. a 32-bit zero into a global scalar fan-out and 32 taps.
  const constantFeeds = new Map<string, Edge[]>();
  for (const edge of routes)
    for (const id of edge.targets) {
      const list = constantFeeds.get(id) ?? [];
      list.push(edge);
      constantFeeds.set(id, list);
    }
  for (const node of graph.nodes)
    for (const port of node.ports) {
      const bits = port.display?.bits;
      if (
        port.direction !== "input" ||
        !bits ||
        bits.length < 2 ||
        !bits.every(
          (b) => typeof b === "string" && ["0", "1", "x", "z"].includes(b),
        )
      )
        continue;
      const feeds = constantFeeds.get(port.id) ?? [];
      if (
        !feeds.length ||
        !feeds.every((edge) =>
          edge.sources.every((id) => ports.get(id)?.node.kind === "constant"),
        )
      )
        continue;
      const original = feeds[0];
      if (!original) continue;
      const binary = [...bits].reverse().join("");
      const title =
        bits.length >= 8 && /^[01]+$/.test(binary)
          ? `${bits.length}'h${BigInt("0b" + binary)
              .toString(16)
              .padStart(Math.ceil(bits.length / 4), "0")}`
          : `${bits.length}'b${binary}`;
      const id = `literal:${port.id}`;
      const constant: Node = {
        id,
        label: title,
        kind: "constant",
        display: syntheticDisplay("constant", title),
        ports: [
          {
            id: `${id}:out`,
            label: "",
            direction: "output",
            signal_ids: [],
            display: {
              name: "",
              width: bits.length,
              bits: [...bits],
              role: "data",
            },
          },
        ],
      };
      nodes.push(constant);
      for (const p of constant.ports)
        ports.set(p.id, { node: constant, port: p });
      for (const edge of feeds)
        edge.targets = edge.targets.filter((id) => id !== port.id);
      routes.push({
        ...original,
        sources: constant.ports.map((p) => p.id),
        targets: [port.id],
        bits: [...bits],
        label: "",
      });
    }
  for (let i = routes.length - 1; i >= 0; i--)
    if (!routes[i]?.targets.length) routes.splice(i, 1);
  // Remove global constants replaced by local uses; retain genuinely used originals.
  const used = new Set(routes.flatMap((e) => [...e.sources, ...e.targets]));
  const visible = nodes.filter(
    (n) => n.kind !== "constant" || n.ports.some((p) => used.has(p.id)),
  );
  const edgeMap: Record<string, string> = {};
  const edgeSignals: Record<string, string[]> = {};
  const routeGroups: Record<string, string> = {};
  const edgeWidths: Record<string, number> = {};
  const edges: ElkExtendedEdge[] = [];
  let serial = 0;
  const add = (
    original: Edge,
    source: string,
    target: string,
    label = "",
    width = original.bits?.length ?? 1,
    signalIds = original.signal_ids,
  ) => {
    if (source === target) return;
    const id = `${original.id}:route:${serial++}`;
    edgeMap[id] = original.id;
    edgeSignals[id] = signalIds;
    edgeWidths[id] = width;
    const local = original.sources.filter(
      (id) => ports.get(id)?.node.kind === "constant",
    );
    routeGroups[id] = JSON.stringify([original.id, width, signalIds, local]);
    edges.push({
      id,
      sources: [source],
      targets: [target],
      labels: label
        ? [
            {
              text: shortName(label, 28),
              width: Math.min(204, label.length * 7),
              height: 14,
            },
          ]
        : [],
      layoutOptions: { "elk.edge.thickness": width > 1 ? "2.5" : "1.5" },
    });
  };
  // A partially connected vector gets a visible split/join, with slices computed
  // from this pin's ordered bits instead of guessing from a signal basename.
  const visibleIds = new Set(visible.map((node) => node.id));
  const attachments = new Map<string, Edge[]>();
  for (const edge of routes)
    for (const id of new Set([...edge.sources, ...edge.targets])) {
      const list = attachments.get(id) ?? [];
      list.push(edge);
      attachments.set(id, list);
    }
  for (const [portId, owner] of ports) {
    const metadata = owner.port.display;
    if (!metadata || metadata.width <= 1 || !visibleIds.has(owner.node.id))
      continue;
    const attached = attachments.get(portId) ?? [];
    if (
      attached.length < 2 ||
      attached.every((e) => e.bits?.length === metadata.width)
    )
      continue;
    const output = owner.port.direction === "output";
    if (owner.port.direction === "inout") continue;
    const id = `bus:${portId}`;
    const whole: Port = {
      ...owner.port,
      id: `${id}:whole`,
      label: `/${metadata.width}`,
      direction: output ? "input" : "output",
    };
    const slices: Port[] = attached.map((edge, i) => {
      const positions = metadata.bits
        .map((b, index) => (edge.bits?.includes(b) ? index : -1))
        .filter((index) => index >= 0);
      const declared = positions
        .map((index) =>
          metadata.range
            ? metadata.range[0] <= metadata.range[1]
              ? metadata.range[1] - index
              : metadata.range[1] + index
            : index,
        )
        .reverse();
      const consecutive =
        declared.length > 1 &&
        declared.every(
          (value, index) =>
            index === 0 ||
            Math.abs(value - (declared[index - 1] ?? value)) === 1,
        );
      const label = declared.length
        ? consecutive
          ? `[${declared[0]}:${declared.at(-1)}]`
          : `[${declared.join(",")}]`
        : "slice";
      return {
        ...owner.port,
        id: `${id}:slice:${i}`,
        label,
        direction: output ? "output" : "input",
        display: {
          ...metadata,
          width: positions.length,
          bits: positions
            .map((index) => metadata.bits[index])
            .filter((bit): bit is string | number => bit !== undefined),
        },
      };
    });
    visible.push({
      id,
      label: pinLabel(owner.port),
      kind: "bus connector",
      ports: [whole, ...slices],
      display: syntheticDisplay("bus_split", ""),
    });
    attached.forEach((edge, i) => {
      const slice = slices[i];
      if (!slice) return;
      if (output) {
        edge.sources = edge.sources.map((p) => (p === portId ? slice.id : p));
        if (i === 0)
          add(
            edge,
            portId,
            whole.id,
            "",
            metadata.width,
            owner.port.signal_ids,
          );
      } else {
        edge.targets = edge.targets.map((p) => (p === portId ? slice.id : p));
        if (i === 0)
          add(
            edge,
            whole.id,
            portId,
            "",
            metadata.width,
            owner.port.signal_ids,
          );
      }
    });
  }
  for (const route of routes) {
    const sourcePorts = [...new Set(route.sources)];
    const targetPorts = [...new Set(route.targets)];
    if (
      sourcePorts.length > 1 ||
      sourcePorts.some((id) => ports.get(id)?.port.direction === "inout")
    ) {
      const id = `junction:${route.id}`;
      const input = `${id}:in`,
        output = `${id}:out`;
      visible.push({
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
      });
      for (const source of sourcePorts) add(route, source, input);
      for (const target of targetPorts) add(route, output, target, route.label);
    } else {
      const source = sourcePorts[0];
      if (!source) continue;
      targetPorts.forEach((target, index) =>
        add(route, source, target, index === 0 ? route.label : ""),
      );
    }
  }
  const children: ElkNode[] = visible.map((node) => {
    const geometry = symbolGeometry(node);
    return {
      id: node.id,
      width: geometry.width,
      height: geometry.height,
      layoutOptions: {
        "elk.portConstraints": "FIXED_POS",
        "elk.partitioning.partition": "1",
      },
      ports: geometry.pins.map((pin) => ({
        id: pin.id,
        x: pin.x,
        y: pin.y,
        width: 0,
        height: 0,
        layoutOptions: { "elk.port.side": pin.side },
      })),
    };
  });
  const columns: LayoutView["columns"] = [];
  const boundaryIds = new Set(
    visible.filter((n) => n.kind === "port").map((n) => n.id),
  );
  const byId = new Map(visible.map((n) => [n.id, n]));
  for (const input of [true, false]) {
    const members = children.filter((n) => {
      const original = byId.get(n.id);
      return (
        original?.kind === "port" &&
        (boundaryDirection(original) === "input") === input
      );
    });
    if (!members.length) continue;
    const width = Math.max(...members.map((n) => n.width ?? 0));
    let height = 0;
    for (const child of members) {
      child.x = input ? width - (child.width ?? 0) : 0;
      child.y = height;
      height += (child.height ?? 0) + 16;
    }
    const id = input ? "layout:inputs" : "layout:outputs";
    columns.push({ id, children: members });
    children.push({
      id,
      width,
      height: height - 16,
      layoutOptions: {
        "elk.portConstraints": "FIXED_POS",
        "elk.partitioning.partition": input ? "0" : "2",
        "elk.layered.layering.layerConstraint": input ? "FIRST" : "LAST",
      },
      ports: members.flatMap((n) =>
        (n.ports ?? []).map((p) => ({
          ...p,
          x: (n.x ?? 0) + (p.x ?? 0),
          y: (n.y ?? 0) + (p.y ?? 0),
        })),
      ),
    });
  }
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
        "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
        "elk.randomSeed": "1",
        ...(columns.length
          ? {
              "elk.partitioning.activate": "true",
              "elk.separateConnectedComponents": "false",
            }
          : {}),
        "elk.layered.thoroughness": visible.length > 400 ? "1" : "7",
        "elk.layered.layering.strategy":
          visible.length > 400 ? "LONGEST_PATH" : "NETWORK_SIMPLEX",
        "elk.layered.nodePlacement.strategy":
          visible.length > 400 ? "SIMPLE" : "BRANDES_KOEPF",
      },
      children: children.filter((n) => !boundaryIds.has(n.id)),
      edges,
    },
    render_nodes: visible,
    edge_map: edgeMap,
    edge_signal_ids: edgeSignals,
    connectors,
    columns,
    route_groups: routeGroups,
    edge_widths: edgeWidths,
    wires: [],
  };
}

/** Restore the real boundary objects after ELK places the two invisible columns. */
export function finishLayout(view: LayoutView, graph: Graph): LayoutView {
  const columns = new Map(view.columns.map((column) => [column.id, column]));
  view.graph.children = view.graph.children?.flatMap((placed) => {
    const column = columns.get(placed.id);
    return column
      ? column.children.map((child) => ({
          ...child,
          x: (placed.x ?? 0) + (child.x ?? 0),
          y: (placed.y ?? 0) + (child.y ?? 0),
        }))
      : [placed];
  });
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
    const paths = routes.flatMap((r) =>
      (r.sections ?? []).map((section) => [
        section.startPoint,
        ...(section.bendPoints ?? []),
        section.endPoint,
      ]),
    );
    const electrical =
      !original.semantics || original.semantics === "electrical";
    const normalized = electrical
      ? electricalPaths(
          paths,
          terminals,
          routes.flatMap((r) => r.junctionPoints ?? []),
        )
      : { paths: paths.map(pathData), junctions: [] };
    return [
      {
        id,
        edge_id: edgeId,
        signal_ids: view.edge_signal_ids[first.id] ?? original.signal_ids,
        width: view.edge_widths[first.id] ?? 1,
        semantics: original.semantics,
        ...normalized,
        labels: routes.flatMap((r) => r.labels ?? []),
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

/** Union only routes of one authoritative net/slice, never coincident foreign nets. */
function electricalPaths(
  paths: ElkPoint[][],
  terminals: Set<string>,
  elkJunctions: ElkPoint[],
) {
  const horizontal = new Map<number, Interval[]>(),
    vertical = new Map<number, Interval[]>();
  const candidates = new Map<string, ElkPoint>();
  const candidate = (p: ElkPoint) =>
    candidates.set(pointKey(p), { x: rounded(p.x), y: rounded(p.y) });
  for (const points of paths) {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1],
        b = points[i];
      if (!a || !b) continue;
      const h = rounded(a.y) === rounded(b.y);
      if (!h && rounded(a.x) !== rounded(b.x))
        throw new Error("Electrical routing must be orthogonal");
      const map = h ? horizontal : vertical,
        key = rounded(h ? a.y : a.x);
      const list = map.get(key) ?? [];
      const start = rounded(h ? a.x : a.y),
        end = rounded(h ? b.x : b.y);
      if (start === end) continue;
      list.push([Math.min(start, end), Math.max(start, end)]);
      map.set(key, list);
      candidate(a);
      candidate(b);
    }
  }
  for (const map of [horizontal, vertical])
    for (const [key, intervals] of map) {
      intervals.sort((a, b) => a[0] - b[0]);
      const merged: Interval[] = [];
      for (const interval of intervals) {
        const last = merged.at(-1);
        if (last && interval[0] <= last[1])
          last[1] = Math.max(last[1], interval[1]);
        else merged.push([...interval]);
      }
      map.set(key, merged);
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
  const lines: string[] = [];
  for (const [y, intervals] of horizontal)
    for (const [a, b] of intervals) lines.push(`M${a},${y} L${b},${y}`);
  for (const [x, intervals] of vertical)
    for (const [a, b] of intervals) lines.push(`M${x},${a} L${x},${b}`);
  return { paths: lines, junctions };
}
