import earcut from "earcut";
import { type Box } from "./floorplan";
import { placedBox } from "./masks";
import { spatialIndex, type IndexRange, type SpatialIndex } from "./mask-scene";
import type { SolidData, SolidMaterial, SolidShapes, SolidSlab } from "./types";

/** Bytes per vertex: x, y, z as float32, the normal as three int8, the slab as uint8. */
export const VERTEX_BYTES = 16;

/** A slab's indices: the top caps first, then the bottom caps and the walls. */
export interface SolidRange extends IndexRange {
  /** How many of the indices are the top caps. */
  caps: number;
}
export interface SolidGeometry {
  vertices: ArrayBuffer;
  indices: Uint32Array;
  /** `layer` is the slab index. */
  ranges: SolidRange[];
  triangles: number;
}

/** Twice the area of a ring of flat x, y; positive when anticlockwise. */
function doubledArea(points: number[], from: number, to: number): number {
  let area = 0;
  for (let i = from; i < to; i++) {
    const j = i + 1 < to ? i + 1 : from;
    area +=
      points[i * 2]! * points[j * 2 + 1]! - points[j * 2]! * points[i * 2 + 1]!;
  }
  return area;
}
/** The rings with the outer one anticlockwise and the holes clockwise. */
function outward(points: number[], holes: number[]): number[] {
  const turned = points.slice();
  for (let ring = 0; ring <= holes.length; ring++) {
    const from = ring ? holes[ring - 1]! : 0;
    const to = holes[ring] ?? points.length / 2;
    if (doubledArea(points, from, to) < 0 === (ring === 0))
      for (let i = from, j = to - 1; i < j; i++, j--)
        for (const axis of [0, 1]) {
          const kept = turned[i * 2 + axis]!;
          turned[i * 2 + axis] = turned[j * 2 + axis]!;
          turned[j * 2 + axis] = kept;
        }
  }
  return turned;
}

const RECTANGLE = [0, 1, 2, 0, 2, 3];
const NO_HOLES: number[] = [];

/**
 * Every shape of each slab as a closed solid: a top and a bottom cap and one
 * wall per edge of every ring, holes included. Coordinates are database units
 * relative to `origin`, so a float32 holds them exactly; heights are the slab's
 * µm times `dbu`. Every triangle is anticlockwise seen from outside the solid,
 * so the faces turned away from the viewer can be skipped.
 */
export function extrude(
  parts: Iterable<[number, SolidShapes]>,
  slabs: readonly SolidSlab[],
  dbu: number,
  origin: [number, number] = [0, 0],
): SolidGeometry {
  // The sizes first, so the buffers are allocated once.
  const prepared: {
    slab: number;
    z0: number;
    z1: number;
    boxes: number[];
    polygons: { points: number[]; holes: number[]; triangles: number[] }[];
    caps: number;
    count: number;
  }[] = [];
  let vertexCount = 0,
    indexCount = 0;
  for (const [slab, shapes] of parts) {
    const range = slabs[slab];
    if (!range) throw new Error(`Unknown slab ${slab}`);
    const boxes = shapes.boxes.length / 4;
    let caps = boxes * 6,
      walls = boxes * 24;
    vertexCount += boxes * 24;
    const polygons = shapes.polygons.map(([points, holes]) => {
      const turned = outward(points, holes);
      const triangles = earcut(turned, holes.length ? holes : undefined);
      caps += triangles.length;
      walls += points.length * 3;
      vertexCount += points.length * 3;
      return { points: turned, holes, triangles };
    });
    const count = caps * 2 + walls;
    prepared.push({
      slab,
      z0: range.zstart * dbu,
      z1: range.zstop * dbu,
      boxes: shapes.boxes,
      polygons,
      caps,
      count,
    });
    indexCount += count;
  }
  const vertices = new ArrayBuffer(vertexCount * VERTEX_BYTES);
  const floats = new Float32Array(vertices);
  const bytes = new Int8Array(vertices);
  const indices = new Uint32Array(indexCount);
  const ranges: SolidRange[] = [];
  let next = 0,
    top = 0,
    rest = 0;
  for (const { slab, z0, z1, boxes, polygons, caps, count } of prepared) {
    const vertex = (
      x: number,
      y: number,
      z: number,
      nx: number,
      ny: number,
      nz: number,
    ) => {
      floats[next * 4] = x - origin[0];
      floats[next * 4 + 1] = y - origin[1];
      floats[next * 4 + 2] = z;
      const at = next * VERTEX_BYTES + 12;
      bytes[at] = Math.round(nx * 127);
      bytes[at + 1] = Math.round(ny * 127);
      bytes[at + 2] = nz * 127;
      bytes[at + 3] = slab;
      return next++;
    };
    const solid = (points: number[], holes: number[], triangles: number[]) => {
      const total = points.length / 2;
      const upper = next;
      for (let i = 0; i < total; i++)
        vertex(points[i * 2]!, points[i * 2 + 1]!, z1, 0, 0, 1);
      const lower = next;
      for (let i = 0; i < total; i++)
        vertex(points[i * 2]!, points[i * 2 + 1]!, z0, 0, 0, -1);
      for (let i = 0; i < triangles.length; i += 3) {
        const a = triangles[i]!;
        let b = triangles[i + 1]!,
          c = triangles[i + 2]!;
        const turn =
          (points[b * 2]! - points[a * 2]!) *
            (points[c * 2 + 1]! - points[a * 2 + 1]!) -
          (points[c * 2]! - points[a * 2]!) *
            (points[b * 2 + 1]! - points[a * 2 + 1]!);
        if (turn < 0) [b, c] = [c, b];
        indices[top++] = upper + a;
        indices[top++] = upper + b;
        indices[top++] = upper + c;
        indices[rest++] = lower + a;
        indices[rest++] = lower + c;
        indices[rest++] = lower + b;
      }
      for (let ring = 0; ring <= holes.length; ring++) {
        const from = ring ? holes[ring - 1]! : 0;
        const to = holes[ring] ?? total;
        for (let i = from; i < to; i++) {
          const j = i + 1 < to ? i + 1 : from;
          const x0 = points[i * 2]!,
            y0 = points[i * 2 + 1]!,
            x1 = points[j * 2]!,
            y1 = points[j * 2 + 1]!;
          const length = Math.hypot(x1 - x0, y1 - y0) || 1;
          const nx = (y1 - y0) / length,
            ny = (x0 - x1) / length;
          const base = vertex(x0, y0, z0, nx, ny, 0);
          vertex(x1, y1, z0, nx, ny, 0);
          vertex(x1, y1, z1, nx, ny, 0);
          vertex(x0, y0, z1, nx, ny, 0);
          indices[rest++] = base;
          indices[rest++] = base + 1;
          indices[rest++] = base + 2;
          indices[rest++] = base;
          indices[rest++] = base + 2;
          indices[rest++] = base + 3;
        }
      }
    };
    const start = top;
    rest = start + caps;
    const corners = [0, 0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < boxes.length; i += 4) {
      corners[0] = corners[6] = boxes[i]!;
      corners[1] = corners[3] = boxes[i + 1]!;
      corners[2] = corners[4] = boxes[i + 2]!;
      corners[5] = corners[7] = boxes[i + 3]!;
      solid(corners, NO_HOLES, RECTANGLE);
    }
    for (const { points, holes, triangles } of polygons)
      solid(points, holes, triangles);
    ranges.push({ layer: slab, start, count, caps });
    top = start + count;
  }
  return { vertices, indices, ranges, triangles: indexCount / 3 };
}

export interface SolidScene {
  dbu: number;
  box: Box;
  materials: SolidMaterial[];
  slabs: SolidSlab[];
  /** Lowest and highest height of the stack, in µm. */
  zRange: [number, number];
  cells: SolidGeometry[];
  /** The top cell's shapes in batches, each relative to its own origin. */
  top: SolidGeometry[];
  /** x, y per top batch, in database units. */
  origins: Int32Array;
  /** cell, x, y, orientation per placement, in database units. */
  instances: Int32Array;
  placements: SpatialIndex;
  routing: SpatialIndex;
  /** Triangles of the whole scene with every placement drawn. */
  triangles: number;
}

/** Called only by the preparation worker, never by a camera update. */
export function prepareSolid(data: SolidData): SolidScene {
  const parts: { slab: number; box: Box; shape: [number[], number[]] | Box }[] =
    [];
  data.shapes.forEach((shapes, slab) => {
    for (let i = 0; i < shapes.boxes.length; i += 4) {
      const box = shapes.boxes.slice(i, i + 4) as Box;
      parts.push({ slab, box, shape: box });
    }
    for (const polygon of shapes.polygons) {
      const [points] = polygon;
      const box: Box = [Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i < points.length; i += 2) {
        box[0] = Math.min(box[0], points[i]!);
        box[2] = Math.max(box[2], points[i]!);
        box[1] = Math.min(box[1], points[i + 1]!);
        box[3] = Math.max(box[3], points[i + 1]!);
      }
      parts.push({ slab, box, shape: polygon });
    }
  });
  // Nearby whole shapes share a batch; a batch's origin keeps its coordinates
  // small. Batches grow with the design, so their number stays in the thousands.
  const partition = spatialIndex(
    parts.map((part) => part.box),
    Math.max(128, Math.ceil(parts.length / 2048)),
  );
  const top: SolidGeometry[] = [];
  const origins: number[] = [];
  const topBoxes: Box[] = [];
  for (let node = 0; node < partition.nodes.length; node += 4) {
    if (partition.nodes[node]! >= 0) continue;
    const bySlab = new Map<number, SolidShapes>();
    const start = partition.nodes[node + 2]!;
    const end = start + partition.nodes[node + 3]!;
    for (let i = start; i < end; i++) {
      const part = parts[partition.order[i]!]!;
      let shapes = bySlab.get(part.slab);
      if (!shapes)
        bySlab.set(part.slab, (shapes = { boxes: [], polygons: [] }));
      if (part.shape.length === 4) shapes.boxes.push(...part.shape);
      else shapes.polygons.push(part.shape);
    }
    const bounds = Array.from(partition.bounds.subarray(node, node + 4)) as Box;
    top.push(extrude(bySlab, data.slabs, data.dbu, [bounds[0], bounds[1]]));
    origins.push(bounds[0], bounds[1]);
    topBoxes.push(bounds);
  }
  const cells = data.cells.map((cell) =>
    extrude(
      Object.entries(cell.slabs).map(([slab, shapes]) => [
        Number(slab),
        shapes,
      ]),
      data.slabs,
      data.dbu,
    ),
  );
  let triangles = top.reduce((n, mesh) => n + mesh.triangles, 0);
  for (const [cell] of data.instances) {
    const mesh = cells[cell];
    if (!mesh) throw new Error(`Unknown layout cell ${cell}`);
    triangles += mesh.triangles;
  }
  return {
    dbu: data.dbu,
    box: data.box,
    materials: data.materials,
    slabs: data.slabs,
    zRange: [
      Math.min(0, ...data.slabs.map((slab) => slab.zstart)),
      Math.max(0, ...data.slabs.map((slab) => slab.zstop)),
    ],
    cells,
    top,
    origins: Int32Array.from(origins),
    instances: Int32Array.from(data.instances.flat()),
    placements: spatialIndex(
      data.instances.map(([cell, x, y, code]) =>
        placedBox(data.cells[cell]!.box, code, x, y),
      ),
    ),
    routing: spatialIndex(topBoxes),
    triangles,
  };
}

export function solidTransfers(scene: SolidScene): ArrayBuffer[] {
  return [
    scene.origins.buffer,
    scene.instances.buffer,
    ...[scene.placements, scene.routing].flatMap((index) => [
      index.bounds.buffer,
      index.nodes.buffer,
      index.order.buffer,
      index.items.buffer,
    ]),
    ...[...scene.cells, ...scene.top].flatMap((mesh) => [
      mesh.vertices,
      mesh.indices.buffer,
    ]),
  ] as ArrayBuffer[];
}
