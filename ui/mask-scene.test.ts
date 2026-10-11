import { describe, expect, it } from "vitest";
import { overlaps, type Box } from "./floorplan";
import {
  geometry,
  prepareMasks,
  querySpatial,
  spatialIndex,
  splitCoordinate,
  expandedBox,
} from "./mask-scene";
import { placedBox } from "./masks";
import type { MaskData } from "./types";

const masks = (): MaskData => ({
  dbu: 1000,
  top: "top",
  box: [0, 0, 100000000, 100000000],
  layers: [],
  cells: [
    {
      name: "cell",
      box: [-2, -3, 8, 12],
      layers: {
        "0": { boxes: [-2, -3, 8, 12], polygons: [] },
      },
    },
  ],
  instances: Array.from({ length: 8 }, (_, code) => [
    0,
    90000001,
    100 * code,
    code,
  ]),
  shapes: [{ boxes: [90000003, 0, 90000013, 10], polygons: [] }],
  labels: [],
});

describe("prepared mask geometry", () => {
  it("retains each database unit across the signed 32-bit coordinate range", () => {
    for (const value of [
      -2147483648, -90000003, -16777217, 0, 16777217, 90000003, 2147483647,
    ]) {
      const [hi, lo] = splitCoordinate(value);
      expect(Math.fround(hi) + Math.fround(lo)).toBe(value);
      const mesh = geometry([
        [0, { boxes: [value, -1, value, 1], polygons: [] }],
      ]);
      expect(mesh.vertices[0]! + mesh.vertices[2]!).toBe(value);
    }
  });
  it("triangulates concave polygons without adding outline diagonals", () => {
    const mesh = geometry([
      [
        2,
        {
          boxes: [10, 0, 12, 3],
          polygons: [[0, 0, 4, 0, 4, 4, 2, 4, 2, 2, 0, 2]],
        },
      ],
    ]);
    expect(mesh.vertices.length / 5).toBe(10);
    expect(mesh.fill.length).toBe(18);
    expect(mesh.frame.length).toBe(20);
    let area = 0;
    for (let i = 0; i < mesh.fill.length; i += 3) {
      const [a, b, c] = [...mesh.fill.slice(i, i + 3)].map((v) => [
        mesh.vertices[v * 5]!,
        mesh.vertices[v * 5 + 1]!,
      ]);
      area +=
        Math.abs(
          (b![0]! - a![0]!) * (c![1]! - a![1]!) -
            (b![1]! - a![1]!) * (c![0]! - a![0]!),
        ) / 2;
    }
    expect(area).toBe(18);
    // The concave ring's final outline edge closes to its first original vertex.
    expect([...mesh.frame.slice(-2)]).toEqual([9, 4]);
  });
  it("keeps all eight orientations and never substitutes boxes at small scales", () => {
    const source = masks();
    const scene = prepareMasks(source);
    expect([...scene.instances]).toEqual(source.instances.flat());
    expect(querySpatial(scene.placements, source.box).sort()).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
    for (let code = 0; code < 8; code++)
      expect([...scene.placements.items.slice(code * 4, code * 4 + 4)]).toEqual(
        placedBox(source.cells[0]!.box, code, 90000001, 100 * code),
      );
    expect(scene.cells[0]!.fill.length).toBe(6);
  });
  it("culls remote routing while retaining whole crossing polygons and original outlines", () => {
    const source = masks();
    source.shapes = [
      { boxes: [], polygons: [[-100, -100, 100, -100, 100, 100, -100, 100]] },
    ];
    for (let i = 0; i < 4096; i++)
      source.shapes[0]!.boxes.push(
        10000 + i * 20,
        10000,
        10010 + i * 20,
        10010,
      );
    const scene = prepareMasks(source);
    const visible = querySpatial(scene.routing, [-1, -1, 1, 1]);
    expect(visible.length).toBeGreaterThan(0);
    const total = scene.top.reduce((n, mesh) => n + mesh.fill.length, 0);
    expect(
      visible.reduce((n, i) => n + scene.top[i]!.fill.length, 0),
    ).toBeLessThan(total / 10);
    expect(scene.top.reduce((n, mesh) => n + mesh.frame.length, 0)).toBe(
      (4096 + 1) * 8,
    );
  });
});

describe("spatial queries", () => {
  it("match inclusive brute-force bounds across leaf and viewport boundaries", () => {
    const boxes: Box[] = Array.from({ length: 1024 }, (_, i) => [
      (i % 32) * 10,
      Math.floor(i / 32) * 10,
      (i % 32) * 10 + 3,
      Math.floor(i / 32) * 10 + 7,
    ]);
    const index = spatialIndex(boxes);
    for (const view of [
      [0, 0, 3, 7],
      [3, 7, 120, 120],
      [-10, -10, 400, 400],
      [400, 400, 500, 500],
    ] as Box[]) {
      expect(querySpatial(index, view).sort((a, b) => a - b)).toEqual(
        boxes.flatMap((box, i) => (overlaps(box, view) ? [i] : [])),
      );
    }
    expect(querySpatial(spatialIndex([]), [0, 0, 1, 1])).toEqual([]);
    expect(querySpatial(index, expandedBox([4, 0, 5, 7], 1))).toEqual([0]);
  });
});
