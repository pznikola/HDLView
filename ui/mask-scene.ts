import earcut from "earcut";
import { type Box } from "./floorplan";
import { placedBox } from "./masks";
import type { MaskData, MaskLayer, MaskShapes } from "./types";

/** Integer DBU coordinates remain exact, including beyond single precision's 2^24. */
export function splitCoordinate(value: number): [number, number] {
  const high = Math.fround(value);
  return [high, value - high];
}

/** A run of indices belonging to one layer or slab. */
export interface IndexRange {
  layer: number;
  start: number;
  count: number;
}
export interface LayerRange {
  layer: number;
  fillStart: number;
  fillCount: number;
  frameStart: number;
  frameCount: number;
}
export interface Geometry {
  /** x high, y high, x low, y low, layer; shared by triangles and outlines. */
  vertices: Float32Array;
  fill: Uint32Array;
  frame: Uint32Array;
  ranges: LayerRange[];
}

export function geometry(layers: Iterable<[number, MaskShapes]>): Geometry {
  const vertices: number[] = [];
  const fill: number[] = [];
  const frame: number[] = [];
  const ranges: LayerRange[] = [];
  const ring = (points: number[], layer: number, rectangle: boolean) => {
    const base = vertices.length / 5;
    const count = points.length / 2;
    for (let i = 0; i < count; i++) {
      const [xh, xl] = splitCoordinate(points[i * 2]!);
      const [yh, yl] = splitCoordinate(points[i * 2 + 1]!);
      vertices.push(xh, yh, xl, yl, layer);
      frame.push(base + i, base + ((i + 1) % count));
    }
    for (const i of rectangle ? [0, 1, 2, 0, 2, 3] : earcut(points))
      fill.push(base + i);
  };
  for (const [layer, shapes] of layers) {
    const fillStart = fill.length;
    const frameStart = frame.length;
    for (let i = 0; i < shapes.boxes.length; i += 4) {
      const [x0, y0, x1, y1] = shapes.boxes.slice(i, i + 4) as Box;
      ring([x0, y0, x1, y0, x1, y1, x0, y1], layer, true);
    }
    for (const points of shapes.polygons) ring(points, layer, false);
    ranges.push({
      layer,
      fillStart,
      fillCount: fill.length - fillStart,
      frameStart,
      frameCount: frame.length - frameStart,
    });
  }
  return {
    vertices: Float32Array.from(vertices),
    fill: Uint32Array.from(fill),
    frame: Uint32Array.from(frame),
    ranges,
  };
}

/** A static median-split BVH. Leaves reference items in `order`. */
export interface SpatialIndex {
  bounds: Float64Array;
  /** left child, right child, item start, item count per node; -1 means leaf. */
  nodes: Int32Array;
  order: Uint32Array;
  items: Float64Array;
}
export function spatialIndex(boxes: Box[], leafSize = 16): SpatialIndex {
  const bounds: number[] = [];
  const nodes: number[] = [];
  const order: number[] = [];
  function build(ids: number[]): number {
    const box: Box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const id of ids) {
      const b = boxes[id]!;
      box[0] = Math.min(box[0], b[0]);
      box[1] = Math.min(box[1], b[1]);
      box[2] = Math.max(box[2], b[2]);
      box[3] = Math.max(box[3], b[3]);
    }
    const node = nodes.length / 4;
    bounds.push(...box);
    nodes.push(-1, -1, order.length, ids.length);
    if (ids.length <= leafSize) order.push(...ids);
    else {
      const axis = box[2] - box[0] >= box[3] - box[1] ? 0 : 1;
      ids.sort(
        (a, b) =>
          boxes[a]![axis] +
          boxes[a]![axis + 2]! -
          (boxes[b]![axis] + boxes[b]![axis + 2]!),
      );
      const middle = Math.floor(ids.length / 2);
      nodes[node * 4] = build(ids.slice(0, middle));
      nodes[node * 4 + 1] = build(ids.slice(middle));
      nodes[node * 4 + 3] = 0;
    }
    return node;
  }
  if (boxes.length) build(boxes.map((_, i) => i));
  return {
    bounds: Float64Array.from(bounds),
    nodes: Int32Array.from(nodes),
    order: Uint32Array.from(order),
    items: Float64Array.from(boxes.flat()),
  };
}
export function querySpatial(index: SpatialIndex, seen: Box): number[] {
  const found: number[] = [];
  const intersects = (values: Float64Array, offset: number) =>
    values[offset]! <= seen[2] &&
    values[offset + 2]! >= seen[0] &&
    values[offset + 1]! <= seen[3] &&
    values[offset + 3]! >= seen[1];
  function visit(node: number) {
    const at = node * 4;
    if (!intersects(index.bounds, at)) return;
    const left = index.nodes[at]!;
    if (left >= 0) {
      visit(left);
      visit(index.nodes[at + 1]!);
    } else {
      const start = index.nodes[at + 2]!;
      const end = start + index.nodes[at + 3]!;
      for (let i = start; i < end; i++) {
        const id = index.order[i]!;
        if (intersects(index.items, id * 4)) found.push(id);
      }
    }
  }
  if (index.nodes.length) visit(0);
  return found;
}

export interface MaskScene {
  dbu: number;
  box: Box;
  layers: MaskLayer[];
  cells: Geometry[];
  top: Geometry[];
  /** cell, x, y, orientation, in original integer DBU. */
  instances: Int32Array;
  placements: SpatialIndex;
  routing: SpatialIndex;
}

/** Called only by the preparation worker, never by a camera update. */
export function prepareMasks(masks: MaskData): MaskScene {
  const parts: { layer: number; box: Box; points?: number[] }[] = [];
  masks.shapes.forEach((shapes, layer) => {
    for (let i = 0; i < shapes.boxes.length; i += 4)
      parts.push({ layer, box: shapes.boxes.slice(i, i + 4) as Box });
    for (const points of shapes.polygons) {
      const box: Box = [Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i < points.length; i += 2) {
        box[0] = Math.min(box[0], points[i]!);
        box[2] = Math.max(box[2], points[i]!);
        box[1] = Math.min(box[1], points[i + 1]!);
        box[3] = Math.max(box[3], points[i + 1]!);
      }
      parts.push({ layer, box, points });
    }
  });
  // Group nearby whole shapes; splitting a polygon would introduce false outline edges.
  const partition = spatialIndex(
    parts.map((part) => part.box),
    128,
  );
  const top: Geometry[] = [];
  const topBoxes: Box[] = [];
  for (let node = 0; node < partition.nodes.length; node += 4) {
    if (partition.nodes[node]! >= 0) continue;
    const byLayer = new Map<number, MaskShapes>();
    const start = partition.nodes[node + 2]!;
    const end = start + partition.nodes[node + 3]!;
    for (let i = start; i < end; i++) {
      const part = parts[partition.order[i]!]!;
      let shapes = byLayer.get(part.layer);
      if (!shapes)
        byLayer.set(part.layer, (shapes = { boxes: [], polygons: [] }));
      if (part.points) shapes.polygons.push(part.points);
      else shapes.boxes.push(...part.box);
    }
    top.push(geometry(byLayer));
    topBoxes.push(Array.from(partition.bounds.subarray(node, node + 4)) as Box);
  }
  return {
    dbu: masks.dbu,
    box: masks.box,
    layers: masks.layers,
    cells: masks.cells.map((cell) =>
      geometry(
        Object.entries(cell.layers).map(([layer, shapes]) => [
          Number(layer),
          shapes,
        ]),
      ),
    ),
    top,
    instances: Int32Array.from(masks.instances.flat()),
    placements: spatialIndex(
      masks.instances.map(([cell, x, y, code]) => {
        const definition = masks.cells[cell];
        if (!definition) throw new Error(`Unknown layout cell ${cell}`);
        return placedBox(definition.box, code, x, y);
      }),
    ),
    routing: spatialIndex(topBoxes),
  };
}

export function sceneTransfers(scene: MaskScene): ArrayBuffer[] {
  return [
    scene.instances.buffer,
    ...[scene.placements, scene.routing].flatMap((index) => [
      index.bounds.buffer,
      index.nodes.buffer,
      index.order.buffer,
      index.items.buffer,
    ]),
    ...[...scene.cells, ...scene.top].flatMap((mesh) => [
      mesh.vertices.buffer,
      mesh.fill.buffer,
      mesh.frame.buffer,
    ]),
  ] as ArrayBuffer[];
}

/** Include outlines whose centreline is just outside the viewport. */
export function expandedBox(box: Box, margin: number): Box {
  return [box[0] - margin, box[1] - margin, box[2] + margin, box[3] + margin];
}
