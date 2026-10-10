import { describe, expect, it } from "vitest";
import {
  automaticSide,
  drawn,
  dropPlace,
  fill,
  fitCamera,
  handleAt,
  overlaps,
  pinAt,
  pinPoints,
  placePin,
  removePin,
  resized,
  sidePins,
  toScreen,
  toWorld,
  visibleBox,
  zoomCamera,
} from "./floorplan";
import type { Floorplan } from "./types";

const plan: Floorplan = {
  width_um: 80,
  height_um: 60,
  pins: [
    { port: "clk", side: "west" },
    { port: "a", side: "east" },
    { port: "b", side: "east" },
  ],
};
describe("floorplan camera", () => {
  it("fits a box in the middle of the canvas with y upwards", () => {
    const camera = fitCamera([0, 0, 80, 60], 920, 520, 60);
    expect(camera.scale).toBeCloseTo(400 / 60);
    const [x, top] = toScreen(camera, [40, 60]);
    expect(x).toBeCloseTo(460);
    expect(top).toBeCloseTo(60);
    expect(toScreen(camera, [40, 0])[1]).toBeCloseTo(460);
    const back = toWorld(camera, [460, 60]);
    expect(back[0]).toBeCloseTo(40);
    expect(back[1]).toBeCloseTo(60);
    const seen = visibleBox(camera, 920, 520);
    expect(overlaps(seen, [0, 0, 80, 60])).toBe(true);
    expect(overlaps(seen, [500, 0, 600, 60])).toBe(false);
  });
  it("zooms about the point under the pointer", () => {
    const camera = fitCamera([0, 0, 80, 60], 920, 520);
    const before = toWorld(camera, [200, 300]);
    const zoomed = zoomCamera(camera, 2, [200, 300]);
    const after = toWorld(zoomed, [200, 300]);
    expect(zoomed.scale).toBeCloseTo(camera.scale * 2);
    expect(after[0]).toBeCloseTo(before[0]);
    expect(after[1]).toBeCloseTo(before[1]);
  });
});
describe("floorplan outline", () => {
  it("is drawn between two points in tenths of a micron and resized by its far edges", () => {
    expect(drawn([10, 70], [90.04, 9.96])).toEqual({
      width_um: 80,
      height_um: 60,
      pins: [],
    });
    expect(drawn([10, 10], [10, 40])).toBeUndefined();
    expect(handleAt(plan, [80.5, 30], 1)).toBe("east");
    expect(handleAt(plan, [40, 59.5], 1)).toBe("north");
    expect(handleAt(plan, [80, 60], 1)).toBe("corner");
    expect(handleAt(plan, [40, 30], 1)).toBeUndefined();
    expect(handleAt(plan, [0, 30], 1)).toBeUndefined();
    expect(resized(plan, "east", [95.26, 10])).toMatchObject({
      width_um: 95.3,
      height_um: 60,
    });
    expect(resized(plan, "north", [95, 42])).toMatchObject({
      width_um: 80,
      height_um: 42,
    });
    expect(resized(plan, "corner", [-5, 42])).toMatchObject({
      width_um: 0.1,
      height_um: 42,
    });
    expect(resized(plan, "corner", [100, 50]).pins).toBe(plan.pins);
  });
  it("tells how full it is and what the flow would choose", () => {
    expect(fill(1200, plan)).toBeCloseTo(25);
    expect(automaticSide(353, 30)).toBe(34.3);
  });
});
describe("floorplan pins", () => {
  it("are spread along their side in order from the low coordinate", () => {
    expect(sidePins(plan, "east")).toEqual(["a", "b"]);
    expect(pinPoints(plan, "east")).toEqual([
      [80, 20],
      [80, 40],
    ]);
    expect(pinPoints(plan, "west")).toEqual([[0, 30]]);
    expect(pinPoints(plan, "north")).toEqual([]);
    expect(pinAt(plan, [79.5, 40.5], 1)).toBe("b");
    expect(pinAt(plan, [40, 30], 1)).toBeUndefined();
  });
  it("move to the nearest side at the dropped place and keep the other pins' order", () => {
    expect(dropPlace(plan, [78, 5])).toEqual({ side: "east", index: 0 });
    expect(dropPlace(plan, [78, 30])).toEqual({ side: "east", index: 1 });
    expect(dropPlace(plan, [78, 55])).toEqual({ side: "east", index: 2 });
    // A pin moved along its own side is placed among the others.
    expect(dropPlace(plan, [78, 55], "a")).toEqual({ side: "east", index: 1 });
    expect(dropPlace(plan, [30, 58])).toEqual({ side: "north", index: 0 });
    const reordered = placePin(plan, "a", "east", 1);
    expect(sidePins(reordered, "east")).toEqual(["b", "a"]);
    expect(sidePins(reordered, "west")).toEqual(["clk"]);
    const moved = placePin(plan, "clk", "east", 1);
    expect(sidePins(moved, "east")).toEqual(["a", "clk", "b"]);
    expect(sidePins(moved, "west")).toEqual([]);
    const added = placePin(plan, "rst", "south", 0);
    expect(added.pins).toHaveLength(4);
    expect(removePin(added, "rst")).toEqual(plan);
  });
});
