import earcut from "earcut";
import { type Box } from "./floorplan";
import { placedBox } from "./masks";
import { spatialIndex, type IndexRange, type SpatialIndex } from "./mask-scene";
import type { SolidData, SolidMaterial, SolidShapes, SolidSlab } from "./types";

/** Bytes per vertex: x, y, z as float32, the normal as three int8, the slab as uint8. */
export const VERTEX_BYTES = 16;

export interface SolidGeometry {
  vertices: ArrayBuffer;
  indices: Uint32Array;
  /** `layer` is the slab index. */
  ranges: IndexRange[];
  triangles: number;
}

/**
 * Every shape of each slab as a closed solid: a top and a bottom cap and one
 * wall per edge of every ring, holes included. Coordinates are database units
 * relative to `origin`, so a float32 holds them exactly; heights are the slab's
 * µm times `dbu`. Walls get the edge's perpendicular as their normal and are
 * lit from both sides, so ring orientation does not matter.
 */
export function extrude(
  parts: Iterable<[number, SolidShapes]>,
  slabs: readonly SolidSlab[],
  dbu: number,
  origin: [number, number] = [0, 0],
): SolidGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const owners: number[] = [];
  const indices: number[] = [];
  const ranges: IndexRange[] = [];
  const vertex = (
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    slab: number,
  ) => {
    positions.push(x - origin[0], y - origin[1], z);
    normals.push(nx, ny, nz);
    owners.push(slab);
    return owners.length - 1;
  };
  const solid = (
    points: number[],
    holes: number[],
    rectangle: boolean,
    z0: number,
    z1: number,
    slab: number,
  ) => {
    const count = points.length / 2;
    const cap = (z: number, nz: number) => {
      const base = owners.length;
      for (let i = 0; i < count; i++)
        vertex(points[i * 2]!, points[i * 2 + 1]!, z, 0, 0, nz, slab);
      for (const i of rectangle
        ? [0, 1, 2, 0, 2, 3]
        : earcut(points, holes.length ? holes : undefined))
        indices.push(base + i);
    };
    cap(z1, 1);
    cap(z0, -1);
    const starts = [0, ...holes, count];
    for (let ring = 0; ring + 1 < starts.length; ring++) {
      const from = starts[ring]!,
        to = starts[ring + 1]!;
      for (let i = from; i < to; i++) {
        const j = i + 1 < to ? i + 1 : from;
        const [x0, y0, x1, y1] = [
          points[i * 2]!,
          points[i * 2 + 1]!,
          points[j * 2]!,
          points[j * 2 + 1]!,
        ];
        const length = Math.hypot(x1 - x0, y1 - y0) || 1;
        const nx = (y1 - y0) / length,
          ny = (x0 - x1) / length;
        const base = vertex(x0, y0, z0, nx, ny, 0, slab);
        vertex(x1, y1, z0, nx, ny, 0, slab);
        vertex(x1, y1, z1, nx, ny, 0, slab);
        vertex(x0, y0, z1, nx, ny, 0, slab);
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }
  };
  for (const [slab, shapes] of parts) {
    const range = slabs[slab];
    if (!range) throw new Error(`Unknown slab ${slab}`);
    const z0 = range.zstart * dbu,
      z1 = range.zstop * dbu;
    const start = indices.length;
    for (let i = 0; i < shapes.boxes.length; i += 4) {
      const [x0, y0, x1, y1] = shapes.boxes.slice(i, i + 4) as Box;
      solid([x0, y0, x1, y0, x1, y1, x0, y1], [], true, z0, z1, slab);
    }
    for (const [points, holes] of shapes.polygons)
      solid(points, holes, false, z0, z1, slab);
    ranges.push({ layer: slab, start, count: indices.length - start });
  }
  const vertices = new ArrayBuffer(owners.length * VERTEX_BYTES);
  const floats = new Float32Array(vertices);
  const bytes = new Int8Array(vertices);
  const unsigned = new Uint8Array(vertices);
  owners.forEach((slab, i) => {
    floats.set(positions.slice(i * 3, i * 3 + 3), i * 4);
    for (let axis = 0; axis < 3; axis++)
      bytes[i * VERTEX_BYTES + 12 + axis] = Math.round(
        normals[i * 3 + axis]! * 127,
      );
    unsigned[i * VERTEX_BYTES + 15] = slab;
  });
  return {
    vertices,
    indices: Uint32Array.from(indices),
    ranges,
    triangles: indices.length / 3,
  };
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
  // Nearby whole shapes share a batch; a batch's origin keeps its coordinates small.
  const partition = spatialIndex(
    parts.map((part) => part.box),
    128,
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
