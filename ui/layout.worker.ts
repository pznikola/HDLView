import ELK from "elkjs/lib/elk-api.js";
import type { Graph } from "./types";
import {
  prepareLayout,
  finishLayout,
  type LayoutView,
} from "./schematic-layout";
const engine = Promise.resolve(
  new ELK({ workerUrl: "/vendor/elk-worker.min.js" }),
);
export type LayoutResponse =
  | { sequence: number; result: LayoutView }
  | { sequence: number; error: string };
self.onmessage = async ({
  data,
}: {
  data: { sequence: number; graph: Graph; fullControlWiring?: boolean };
}) => {
  try {
    const prepared = prepareLayout(data.graph, data.fullControlWiring);
    prepared.graph = await (await engine).layout(prepared.graph);
    finishLayout(prepared, data.graph);
    self.postMessage({
      sequence: data.sequence,
      result: prepared,
    } satisfies LayoutResponse);
  } catch (error) {
    self.postMessage({
      sequence: data.sequence,
      error: String(error),
    } satisfies LayoutResponse);
  }
};
