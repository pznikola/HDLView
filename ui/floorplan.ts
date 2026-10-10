import type { Floorplan, Side } from "./types";

/** [x0, y0, x1, y1] in microns, y upwards. */
export type Box = [number, number, number, number];
export type Point = [number, number];
/** World point at the canvas's top left corner, and pixels per micron. */
export interface Camera {
  x: number;
  y: number;
  scale: number;
}
export const SIDES: Side[] = ["north", "east", "south", "west"];
export const SIDE_LABELS: Record<Side, string> = {
  north: "Top",
  east: "Right",
  south: "Bottom",
  west: "Left",
};

export function toScreen(camera: Camera, [x, y]: Point): Point {
  return [(x - camera.x) * camera.scale, (camera.y - y) * camera.scale];
}
export function toWorld(camera: Camera, [x, y]: Point): Point {
  return [camera.x + x / camera.scale, camera.y - y / camera.scale];
}
/** The camera that shows a box centred, with a margin in pixels around it. */
export function fitCamera(
  box: Box,
  width: number,
  height: number,
  margin = 60,
): Camera {
  const scale = Math.max(
    1e-6,
    Math.min(
      (width - 2 * margin) / Math.max(box[2] - box[0], 1e-6),
      (height - 2 * margin) / Math.max(box[3] - box[1], 1e-6),
    ),
  );
  return {
    x: (box[0] + box[2]) / 2 - width / 2 / scale,
    y: (box[1] + box[3]) / 2 + height / 2 / scale,
    scale,
  };
}
/** Scale the view, keeping the world point under a canvas point in place. */
export function zoomCamera(camera: Camera, factor: number, at: Point): Camera {
  const [x, y] = toWorld(camera, at);
  const scale = Math.min(2000, Math.max(0.01, camera.scale * factor));
  return { x: x - at[0] / scale, y: y + at[1] / scale, scale };
}
/** The part of the world a canvas of this size shows. */
export function visibleBox(camera: Camera, width: number, height: number): Box {
  return [
    camera.x,
    camera.y - height / camera.scale,
    camera.x + width / camera.scale,
    camera.y,
  ];
}
export function overlaps(a: Box, b: Box): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/** Sizes are kept to a tenth of a micron. */
export function snap(value: number): number {
  return Math.round(value * 10) / 10;
}
/** The outline dragged out between two points; its origin stays at 0, 0. */
export function drawn(from: Point, to: Point): Floorplan | undefined {
  const width_um = snap(Math.abs(to[0] - from[0]));
  const height_um = snap(Math.abs(to[1] - from[1]));
  return width_um > 0 && height_um > 0
    ? { width_um, height_um, pins: [] }
    : undefined;
}
export type Handle = "east" | "north" | "corner";
/** The edge or corner of the outline that can be dragged from a point. */
export function handleAt(
  plan: Floorplan,
  [x, y]: Point,
  tolerance: number,
): Handle | undefined {
  const east =
    Math.abs(x - plan.width_um) <= tolerance &&
    y >= -tolerance &&
    y <= plan.height_um + tolerance;
  const north =
    Math.abs(y - plan.height_um) <= tolerance &&
    x >= -tolerance &&
    x <= plan.width_um + tolerance;
  return east && north ? "corner" : east ? "east" : north ? "north" : undefined;
}
export function resized(
  plan: Floorplan,
  handle: Handle,
  [x, y]: Point,
): Floorplan {
  return {
    ...plan,
    width_um: handle === "north" ? plan.width_um : Math.max(0.1, snap(x)),
    height_um: handle === "east" ? plan.height_um : Math.max(0.1, snap(y)),
  };
}

/** Placed ports of one side, in their order from the low coordinate up. */
export function sidePins(plan: Floorplan, side: Side): string[] {
  return plan.pins.filter((pin) => pin.side === side).map((pin) => pin.port);
}
/** Where the pins of a side are drawn: spread evenly along it. */
export function pinPoints(plan: Floorplan, side: Side): Point[] {
  const count = sidePins(plan, side).length;
  return Array.from({ length: count }, (_, index): Point => {
    const along = (index + 1) / (count + 1);
    return side === "north"
      ? [along * plan.width_um, plan.height_um]
      : side === "south"
        ? [along * plan.width_um, 0]
        : side === "east"
          ? [plan.width_um, along * plan.height_um]
          : [0, along * plan.height_um];
  });
}
/** The side nearest to a point and the place among that side's pins. */
export function dropPlace(
  plan: Floorplan,
  [x, y]: Point,
  moving?: string,
): { side: Side; index: number } {
  const distances: [Side, number][] = [
    ["north", Math.abs(y - plan.height_um)],
    ["east", Math.abs(x - plan.width_um)],
    ["south", Math.abs(y)],
    ["west", Math.abs(x)],
  ];
  const side = distances.reduce((best, next) =>
    next[1] < best[1] ? next : best,
  )[0];
  const horizontal = side === "north" || side === "south";
  const others = sidePins(plan, side).filter((port) => port !== moving);
  const along =
    (horizontal ? x / plan.width_um : y / plan.height_um) * (others.length + 1);
  return {
    side,
    index: Math.min(others.length, Math.max(0, Math.round(along - 0.5))),
  };
}
/** Put a port at a place among a side's pins, taking it from where it was. */
export function placePin(
  plan: Floorplan,
  port: string,
  side: Side,
  index: number,
): Floorplan {
  const pins = plan.pins.filter((pin) => pin.port !== port);
  const onSide = pins.filter((pin) => pin.side === side);
  const before = onSide[index];
  const at = before ? pins.indexOf(before) : pins.length;
  pins.splice(at, 0, { port, side });
  return { ...plan, pins };
}
export function removePin(plan: Floorplan, port: string): Floorplan {
  return { ...plan, pins: plan.pins.filter((pin) => pin.port !== port) };
}
/** The placed port drawn within `tolerance` of a point. */
export function pinAt(
  plan: Floorplan,
  point: Point,
  tolerance: number,
): string | undefined {
  for (const side of SIDES) {
    const ports = sidePins(plan, side);
    const index = pinPoints(plan, side).findIndex(
      ([x, y]) =>
        Math.abs(x - point[0]) <= tolerance &&
        Math.abs(y - point[1]) <= tolerance,
    );
    if (index >= 0) return ports[index];
  }
  return undefined;
}

/** Share of the outline that the cells fill, in percent. */
export function fill(cellArea: number, plan: Floorplan): number {
  return (100 * cellArea) / (plan.width_um * plan.height_um);
}
/** The square the flow sizes for a cell area at a core utilization in percent. */
export function automaticSide(cellArea: number, utilization: number): number {
  return snap(Math.sqrt(cellArea / (utilization / 100)));
}
