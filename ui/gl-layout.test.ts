import { describe, expect, it } from "vitest";
import {
  anchor,
  DETAIL_PIXELS,
  geometry,
  patternAtlas,
  patternBit,
  patternSize,
  placements,
} from "./gl-layout";
import type { MaskData, MaskLayer } from "./types";

const layer = (pattern: string[], offset = 0): MaskLayer => ({
  name: "met1",
  source: "68/20",
  fill: "#0000ff",
  frame: "#0000ff",
  pattern,
  visible: true,
  offset,
});

describe("mask geometry", () => {
  it("turns boxes and polygons into triangles and edges on their layer", () => {
    const { fill, frame } = geometry(
      [
        [2, { boxes: [0, 0, 10, 5], polygons: [] }],
        [3, { boxes: [], polygons: [[0, 0, 4, 0, 4, 4, 2, 4, 2, 2, 0, 2]] }],
      ],
      100,
      200,
    );
    // Two triangles for the box, four for the six-point L shape; three numbers a vertex.
    expect(fill.length).toBe((6 + 12) * 3);
    expect([...fill.slice(0, 9)]).toEqual([
      100, 200, 2, 110, 200, 2, 110, 205, 2,
    ]);
    expect(fill.filter((_, index) => index % 3 === 2)).toEqual(
      Float32Array.from([
        ...new Array<number>(6).fill(2),
        ...new Array<number>(12).fill(3),
      ]),
    );
    // Every edge once, as two vertices.
    expect(frame.length).toBe((4 + 6) * 2 * 3);
    expect([...frame.slice(0, 6)]).toEqual([100, 200, 2, 110, 200, 2]);
    expect([...frame.slice(frame.length - 6)]).toEqual([
      100, 202, 3, 100, 200, 3,
    ]);
  });
});

describe("fill patterns", () => {
  it("repeat from the bottom row up and shift with the layer's position", () => {
    const hatched = layer(["*...", ".*..", "..*.", "...*"]);
    expect(patternSize(hatched)).toEqual([4, 4]);
    // Row 0 from the bottom is the last row of the file.
    expect(patternBit(hatched, 3, 0)).toBe(true);
    expect(patternBit(hatched, 0, 0)).toBe(false);
    expect(patternBit(hatched, 0, 3)).toBe(true);
    expect(patternBit(hatched, 4, 7)).toBe(true);
    const shifted = layer(["*...", ".*..", "..*.", "...*"], 1);
    expect(patternBit(shifted, 2, 0)).toBe(true);
    expect(patternBit(layer(["."]), 0, 0)).toBe(false);
    expect(patternBit(layer([]), 0, 0)).toBe(false);
  });
  it("are packed into one texture, a 32-row block per layer", () => {
    const atlas = patternAtlas([layer(["*"]), layer(["**..", "...."])]);
    expect(atlas.length).toBe(32 * 32 * 2);
    expect(atlas[0]).toBe(255);
    expect(atlas[1]).toBe(0);
    // The second layer's bottom row is its last file row, so its top row sits one up.
    expect(atlas[(32 + 1) * 32]).toBe(255);
    expect(atlas[(32 + 1) * 32 + 2]).toBe(0);
    expect(atlas[32 * 32]).toBe(0);
  });
});

describe("placements", () => {
  const masks: MaskData = {
    dbu: 1000,
    top: "top",
    box: [0, 0, 100000, 100000],
    layers: [],
    cells: [{ name: "inv", box: [0, 0, 1000, 2000], layers: {} }],
    instances: [
      [0, 10000, 10000, 0],
      [0, 20000, 10000, 2],
      [0, 90000, 90000, 0],
    ],
    shapes: [],
    labels: [],
  };
  it("are relative to the layout's centre and split by their size on screen", () => {
    expect(anchor(masks)).toEqual([50000, 50000]);
    // 40 px per micron: a 1 µm cell is 40 px wide, so it is drawn in full.
    const close = placements(
      masks,
      { x: 0, y: 30, scale: 40 },
      { width: 800, height: 800 },
    );
    expect([...close.detailed.get(0)!]).toEqual([
      -40000, -40000, 0, -30000, -40000, 2,
    ]);
    expect(close.boxes.length).toBe(0);
    // Zoomed out, the same cells are narrower than the limit and become boxes.
    const far = placements(
      masks,
      { x: 0, y: 100, scale: DETAIL_PIXELS - 0.5 },
      { width: 800, height: 800 },
    );
    expect(far.detailed.size).toBe(0);
    expect([...far.boxes]).toEqual([
      -40000, -40000, -39000, -38000, -31000, -42000, -30000, -40000, 40000,
      40000, 41000, 42000,
    ]);
  });
});
