import { describe, expect, it } from "vitest";
import { querySpatial } from "./mask-scene";
import {
  extrude,
  prepareSolid,
  VERTEX_BYTES,
  type SolidGeometry,
} from "./solid-scene";
import type { SolidData, SolidSlab } from "./types";

const slabs: SolidSlab[] = [
  { material: 0, zstart: 1, zstop: 1.5 },
  { material: 1, zstart: 2, zstop: 2.25 },
];
const vertexCount = (mesh: SolidGeometry) =>
  mesh.vertices.byteLength / VERTEX_BYTES;
const position = (mesh: SolidGeometry, index: number) =>
  Array.from(new Float32Array(mesh.vertices, index * VERTEX_BYTES, 3));
const normal = (mesh: SolidGeometry, index: number) =>
  Array.from(new Int8Array(mesh.vertices, index * VERTEX_BYTES + 12, 3));
const slabOf = (mesh: SolidGeometry, index: number) =>
  new Uint8Array(mesh.vertices)[index * VERTEX_BYTES + 15];

describe("extrude", () => {
  it("turns a box into a closed solid between the slab's heights", () => {
    const mesh = extrude(
      [[1, { boxes: [0, 0, 10, 20], polygons: [] }]],
      slabs,
      1000,
    );
    expect(vertexCount(mesh)).toBe(24);
    expect(mesh.indices.length).toBe(36);
    expect(mesh.triangles).toBe(12);
    expect(mesh.ranges).toEqual([{ layer: 1, start: 0, count: 36 }]);
    const heights = new Set<number>();
    const normals = new Set<string>();
    for (let i = 0; i < 24; i++) {
      heights.add(position(mesh, i)[2]!);
      normals.add(normal(mesh, i).join(","));
      expect(slabOf(mesh, i)).toBe(1);
    }
    expect([...heights].sort()).toEqual([2000, 2250]);
    expect([...normals].sort()).toEqual(
      [
        "0,0,127",
        "0,0,-127",
        "127,0,0",
        "-127,0,0",
        "0,127,0",
        "0,-127,0",
      ].sort(),
    );
    expect(Math.max(...mesh.indices)).toBe(23);
  });

  it("places coordinates relative to the origin", () => {
    const mesh = extrude(
      [[0, { boxes: [5, 7, 15, 17], polygons: [] }]],
      slabs,
      1000,
      [5, 7],
    );
    expect(position(mesh, 0)).toEqual([0, 0, 1500]);
    expect(position(mesh, 2)).toEqual([10, 10, 1500]);
  });

  it("walls every ring of a polygon with a hole and caps the ring", () => {
    const outer = [0, 0, 10, 0, 10, 10, 0, 10];
    const hole = [2, 2, 2, 8, 8, 8, 8, 2];
    const mesh = extrude(
      [[0, { boxes: [], polygons: [[[...outer, ...hole], [4]]] }]],
      slabs,
      1,
    );
    // Two caps of eight triangles each and eight walls of two.
    expect(mesh.triangles).toBe(32);
    expect(vertexCount(mesh)).toBe(16 + 8 * 4);
    const wallNormals = new Set<string>();
    for (let i = 16; i < vertexCount(mesh); i++)
      wallNormals.add(normal(mesh, i).join(","));
    expect(wallNormals.size).toBe(4);
  });

  it("keeps one index range per slab and rejects unknown slabs", () => {
    const mesh = extrude(
      [
        [0, { boxes: [0, 0, 1, 1], polygons: [] }],
        [1, { boxes: [0, 0, 1, 1, 2, 2, 3, 3], polygons: [] }],
      ],
      slabs,
      1,
    );
    expect(mesh.ranges).toEqual([
      { layer: 0, start: 0, count: 36 },
      { layer: 1, start: 36, count: 72 },
    ]);
    expect(() => extrude([[2, { boxes: [], polygons: [] }]], slabs, 1)).toThrow(
      "Unknown slab 2",
    );
  });
});

describe("prepareSolid", () => {
  const data = (): SolidData => ({
    dbu: 1000,
    top: "top",
    box: [0, 0, 100000, 100000],
    materials: [
      { name: "met1", fill: "#0000ff", source: "68/20" },
      { name: "via", fill: "#ffffff", source: null },
    ],
    slabs,
    cells: [
      {
        name: "leaf",
        box: [0, 0, 10, 10],
        slabs: { "0": { boxes: [0, 0, 10, 10], polygons: [] } },
      },
    ],
    instances: [
      [0, 1000, 1000, 0],
      [0, 50000, 50000, 4],
    ],
    shapes: [
      { boxes: [20000, 20000, 30000, 21000], polygons: [] },
      { boxes: [80000, 80000, 81000, 81000], polygons: [] },
    ],
  });

  it("batches the top shapes around their own origins and counts the scene", () => {
    const scene = prepareSolid(data());
    expect(scene.top.length).toBe(1);
    expect(Array.from(scene.origins)).toEqual([20000, 20000]);
    expect(position(scene.top[0]!, 0)).toEqual([0, 0, 1500]);
    expect(scene.top[0]!.ranges.map((range) => range.layer)).toEqual([0, 1]);
    expect(scene.zRange).toEqual([0, 2.25]);
    expect(scene.triangles).toBe(24 + 2 * 12);
    expect(Array.from(scene.instances)).toEqual([
      0, 1000, 1000, 0, 0, 50000, 50000, 4,
    ]);
    expect(querySpatial(scene.placements, [0, 0, 2000, 2000])).toEqual([0]);
    expect(querySpatial(scene.routing, [0, 0, 2000, 2000])).toEqual([]);
    expect(querySpatial(scene.routing, [79000, 79000, 82000, 82000])).toEqual([
      0,
    ]);
  });

  it("reports a placement of an unknown cell", () => {
    const broken = data();
    broken.instances.push([3, 0, 0, 0]);
    expect(() => prepareSolid(broken)).toThrow("Unknown layout cell 3");
  });
});
