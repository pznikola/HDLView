import { describe, expect, it } from "vitest";
import { besideRouting, orientation, placedBox } from "./masks";

const apply = (code: number, x: number, y: number) => {
  const [a, b, c, d] = orientation(code);
  return [a * x + c * y, b * x + d * y];
};
describe("mask orientations", () => {
  it("follow KLayout's eight codes", () => {
    // r0, r90, r180, r270, then m0, m45, m90, m135.
    expect(apply(0, 2, 1)).toEqual([2, 1]);
    expect(apply(1, 2, 1)).toEqual([-1, 2]);
    expect(apply(2, 2, 1)).toEqual([-2, -1]);
    expect(apply(3, 2, 1)).toEqual([1, -2]);
    expect(apply(4, 2, 1)).toEqual([2, -1]);
    expect(apply(5, 2, 1)).toEqual([1, 2]);
    expect(apply(6, 2, 1)).toEqual([-2, 1]);
    expect(apply(7, 2, 1)).toEqual([-1, -2]);
  });
  it("place a cell's box where its instance covers the layout", () => {
    const cell = [-1, -2, 9, 18];
    expect(placedBox(cell, 0, 100, 200)).toEqual([99, 198, 109, 218]);
    expect(placedBox(cell, 4, 100, 200)).toEqual([99, 182, 109, 202]);
    expect(placedBox(cell, 2, 100, 200)).toEqual([91, 182, 101, 202]);
    expect(placedBox(cell, 1, 100, 200)).toEqual([82, 199, 102, 209]);
  });
});
describe("routing layers", () => {
  it("are the purposes of the technology's metal and via layers", () => {
    const layers = [
      { name: "nwell.drawing - 64/20", source: "64/20" },
      { name: "met1.drawing - 68/20", source: "68/20" },
      { name: "met1.pin - 68/16", source: "68/16" },
      { name: "via.drawing - 68/44", source: "68/44" },
      { name: "81/4", source: "81/4" },
    ];
    expect(besideRouting(layers, ["met1", "via"])).toEqual(["64/20", "81/4"]);
  });
});
