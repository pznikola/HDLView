import { describe, expect, it } from "vitest";
import { geometry } from "./mask-scene";
import {
  patternAtlas,
  patternBit,
  patternSize,
  viewportSize,
  visibleIndices,
} from "./gl-layout";
import type { MaskLayer } from "./types";

const layer = (pattern: string[], offset = 0): MaskLayer => ({
  name: "met1",
  source: "68/20",
  fill: "#0000ff",
  frame: "#0000ff",
  pattern,
  visible: true,
  offset,
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

describe("viewport and layer indices", () => {
  it.each([1, 1.25, 1.5, 2])(
    "shares one rounded backing size at DPR %s",
    (ratio) => {
      const view = viewportSize(803, 501, ratio);
      expect(view.pixelWidth).toBe(Math.round(803 * ratio));
      expect(view.pixelHeight).toBe(Math.round(501 * ratio));
      expect(view.width).toBe(803);
      expect(view.height).toBe(501);
    },
  );
  it("excludes hidden geometry from both passes without changing vertices", () => {
    const mesh = geometry([
      [0, { boxes: [0, 0, 2, 3], polygons: [] }],
      [1, { boxes: [], polygons: [[0, 0, 2, 0, 2, 2]] }],
    ]);
    const original = mesh.vertices.slice();
    expect(visibleIndices(mesh, [false, true], false).length).toBe(3);
    expect(visibleIndices(mesh, [false, true], true).length).toBe(6);
    expect(
      [...visibleIndices(mesh, [false, true], false)].every(
        (index) => mesh.vertices[index * 5 + 4] === 1,
      ),
    ).toBe(true);
    expect(visibleIndices(mesh, [false, false], true).length).toBe(0);
    expect(visibleIndices(mesh, [true, true], false)).toEqual(mesh.fill);
    expect(mesh.vertices).toEqual(original);
  });
});
