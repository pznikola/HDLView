import ELK from "elkjs/lib/elk-api.js";
const engine = Promise.resolve(
  new ELK({ workerUrl: "/vendor/elk-worker.min.js" }),
);
import type { Graph } from "./types";
import type { ElkNode } from "elkjs";

export type LayoutResponse =
  | { sequence: number; result: ElkNode }
  | { sequence: number; error: string };

self.onmessage = async ({
  data,
}: {
  data: { sequence: number; graph: Graph };
}) => {
  try {
    const g = data.graph;
    const nodes = g.nodes.map((n) => ({
      id: n.id,
      width: n.kind === "port" ? 125 : 190,
      height: Math.max(
        80,
        32 +
          Math.max(
            n.ports.filter((p) => p.direction !== "output").length,
            n.ports.filter((p) => p.direction === "output").length,
          ) *
            22,
      ),
      layoutOptions: { "elk.portConstraints": "FIXED_ORDER" },
      ports: n.ports.map((p, i) => ({
        id: p.id,
        width: 8,
        height: 8,
        layoutOptions: {
          "elk.port.side": p.direction === "output" ? "EAST" : "WEST",
          "elk.port.index": String(i),
        },
      })),
    }));
    const edges = g.edges.flatMap((e) =>
      e.sources.flatMap((s, i) =>
        e.targets
          .filter((t) => t !== s)
          .map((t, j) => ({
            id: `${e.id}/${i}/${j}`,
            sources: [s],
            targets: [t],
            labels: e.label
              ? [
                  {
                    text: e.label,
                    width: Math.min(180, e.label.length * 7),
                    height: 14,
                  },
                ]
              : [],
          })),
      ),
    );
    const result = await (
      await engine
    ).layout({
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.edgeRouting": "ORTHOGONAL",
        "elk.spacing.nodeNode": "36",
        "elk.layered.spacing.nodeNodeBetweenLayers": "100",
        "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
        // Bound interactive work on large views; small diagrams retain the fuller heuristics.
        "elk.layered.thoroughness": g.nodes.length > 400 ? "1" : "7",
        "elk.layered.layering.strategy":
          g.nodes.length > 400 ? "LONGEST_PATH" : "NETWORK_SIMPLEX",
        "elk.layered.nodePlacement.strategy":
          g.nodes.length > 400 ? "SIMPLE" : "BRANDES_KOEPF",
      },
      children: nodes,
      edges,
    });
    self.postMessage({
      sequence: data.sequence,
      result,
    } satisfies LayoutResponse);
  } catch (error) {
    self.postMessage({
      sequence: data.sequence,
      error: String(error),
    } satisfies LayoutResponse);
  }
};
