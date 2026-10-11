import { describe, expect, it } from "vitest";
import { viewportSize } from "./gl-layout";
import {
  basis,
  dolly,
  fitSolid,
  footprint,
  highlightGeometry,
  orbit,
  pan,
  project,
  sceneAnchor,
  topView,
  FOV,
  type SolidCamera,
} from "./gl-solid";
import { prepareSolid, VERTEX_BYTES } from "./solid-scene";
import type { SolidData } from "./types";

const data = (): SolidData => ({
  dbu: 1000,
  top: "top",
  box: [0, 0, 100000, 100000],
  materials: [{ name: "met1", fill: "#0000ff", source: "68/20" }],
  slabs: [{ material: 0, zstart: 1, zstop: 1.5 }],
  cells: [],
  instances: [],
  shapes: [{ boxes: [50000, 50000, 51000, 51000], polygons: [] }],
});
const viewport = viewportSize(800, 600, 1);
const camera = (): SolidCamera => ({
  pivot: [50, 50, 1],
  azimuth: 30,
  elevation: 40,
  distance: 200,
  zScale: 1,
});

describe("3D camera", () => {
  it("fits the box around its centre at a distance that shows it whole", () => {
    const fitted = fitSolid([0, 0, 100, 60], [0, 5], 800 / 600);
    expect(fitted.pivot).toEqual([50, 30, 2.5]);
    const radius = Math.hypot(100, 60, 5) / 2;
    expect(fitted.distance).toBeGreaterThan(radius);
    expect(fitSolid([0, 0, 100, 60], [0, 5], 0.5).distance).toBeGreaterThan(
      fitted.distance,
    );
  });

  it("keeps the basis orthonormal with z up at every elevation", () => {
    for (const elevation of [-90, 0, 35, 90]) {
      const { forward, right, up } = basis({ ...camera(), elevation });
      const dot = (a: number[], b: number[]) =>
        a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
      expect(Math.abs(dot(forward, up))).toBeLessThan(1e-9);
      expect(Math.abs(dot(forward, right))).toBeLessThan(1e-9);
      expect(Math.hypot(...up)).toBeCloseTo(1);
      expect(right[2]).toBeCloseTo(0);
    }
    const north = basis(topView(camera())).up;
    expect(north[0]).toBeCloseTo(0);
    expect(north[1]).toBeCloseTo(1);
    expect(north[2]).toBeCloseTo(0);
  });

  it("projects the pivot to the centre and higher points upwards", () => {
    const scene = prepareSolid(data());
    const view = camera();
    expect(project(view, viewport, scene, view.pivot)[0]).toBeCloseTo(0);
    expect(project(view, viewport, scene, view.pivot)[1]).toBeCloseTo(0);
    const above = project(view, viewport, scene, [50, 50, 3]);
    expect(above[1]).toBeGreaterThan(0);
    expect(above[0]).toBeCloseTo(0);
    const stretched = project(
      { ...view, zScale: 4 },
      viewport,
      scene,
      [50, 50, 3],
    );
    expect(stretched[1]).toBeGreaterThan(above[1]);
    const top = topView(view);
    expect(project(top, viewport, scene, [50, 60, 1])[1]).toBeGreaterThan(0);
    expect(project(top, viewport, scene, [60, 50, 1])[0]).toBeGreaterThan(0);
  });

  it("turns, tilts, pans and dollies within their limits", () => {
    const turned = orbit(camera(), -1000, 1000);
    expect(turned.azimuth).toBeGreaterThanOrEqual(0);
    expect(turned.azimuth).toBeLessThan(360);
    expect(turned.elevation).toBe(90);
    expect(orbit(camera(), 0, -1000).elevation).toBe(-90);
    const top = topView(camera());
    const moved = pan(top, 300, 0, viewport);
    const perPixel = (2 * 200 * Math.tan((FOV / 2) * (Math.PI / 180))) / 600;
    expect(moved.pivot[0]).toBeCloseTo(50 - 300 * perPixel);
    expect(moved.pivot[1]).toBeCloseTo(50);
    expect(moved.pivot[2]).toBeCloseTo(1);
    expect(pan(top, 0, -300, viewport).pivot[1]).toBeCloseTo(
      50 - 300 * perPixel,
    );
    expect(dolly(camera(), 1e9).distance).toBe(1e7);
    expect(dolly(camera(), 0).distance).toBe(0.01);
  });

  it("limits the footprint to the ground the corner rays reach", () => {
    const box: [number, number, number, number] = [0, 0, 1000, 1000];
    const top = {
      ...topView(camera()),
      pivot: [500, 500, 0] as [number, number, number],
    };
    const half = 200 * Math.tan((FOV / 2) * (Math.PI / 180));
    const seen = footprint(top, viewport, box, [0, 0]);
    expect(seen[0]).toBeCloseTo(500 - half * (800 / 600));
    expect(seen[2]).toBeCloseTo(500 + half * (800 / 600));
    expect(seen[1]).toBeCloseTo(500 - half);
    expect(seen[3]).toBeCloseTo(500 + half);
    expect(
      footprint({ ...top, distance: 5000 }, viewport, box, [0, 0]),
    ).toEqual(box);
    // Rays above the horizon see to the edge of the scene.
    expect(footprint({ ...top, elevation: 5 }, viewport, box, [0, 2])).toEqual(
      box,
    );
  });

  it("builds highlights relative to the scene anchor", () => {
    const scene = prepareSolid(data());
    expect(sceneAnchor(scene)).toEqual([50000, 50000]);
    const mesh = highlightGeometry(
      scene,
      new Map([[0, [50000, 50000, 51000, 51000]]]),
    );
    expect(mesh.triangles).toBe(12);
    expect(Array.from(new Float32Array(mesh.vertices, 0, 3))).toEqual([
      0, 0, 1500,
    ]);
    expect(new Uint8Array(mesh.vertices)[VERTEX_BYTES - 1]).toBe(0);
  });
});
