import { test, expect } from "@playwright/test";
import { solidScripts, mountSolid } from "../tools/solid-browser.mjs";
import type { SolidCamera } from "../ui/gl-solid";
import type { SolidGeometry, SolidScene } from "../ui/solid-scene";
import type { SolidData } from "../ui/types";

declare global {
  interface Window {
    solidProbe: {
      scene: SolidScene;
      gl: WebGL2RenderingContext;
      hidden: Set<string>;
      contextLost: boolean;
      restoreContext(): void;
      size: { width: number; height: number };
      fit(zScale?: number): SolidCamera;
      draw(
        camera: SolidCamera,
        ratio?: number,
        highlight?: SolidGeometry,
      ): { cpuMs: number; calls: number; indices: number };
      pixel(x: number, y: number, ratio?: number): number[];
    };
    SolidRenderer: typeof import("../ui/gl-solid");
  }
}
let scripts: { renderer: string; worker: string };
test.beforeAll(async () => {
  scripts = await solidScripts();
});
const BACKGROUND = [14, 23, 32];
const fixture = (shape: number[], zstop = 1.5): SolidData => ({
  dbu: 1000,
  top: "top",
  box: [0, 0, 100000, 100000],
  materials: [{ name: "met1", fill: "#ff0000", source: "68/20" }],
  slabs: [{ material: 0, zstart: 1, zstop }],
  cells: [],
  instances: [],
  shapes: [{ boxes: shape, polygons: [] }],
});
const red = (pixel: number[]) =>
  pixel[0]! > 180 && pixel[1]! < 40 && pixel[2]! < 40;

test("a slab shows its lit fill where it is and nothing where it is not", async ({
  page,
}) => {
  const size = { width: 800, height: 600 };
  const setup = await mountSolid(
    page,
    fixture([40000, 40000, 60000, 60000]),
    scripts,
    size,
  );
  expect(setup.triangles).toBe(12);
  const result = await page.evaluate(() => {
    const probe = window.solidProbe;
    const top = window.SolidRenderer.topView(probe.fit());
    const first = probe.draw(top, 1);
    const centre = probe.pixel(400, 300, 1);
    const corner = probe.pixel(10, 10, 1);
    probe.hidden.add("met1");
    const hidden = probe.draw(top, 1);
    const cleared = probe.pixel(400, 300, 1);
    probe.hidden.clear();
    const oblique = probe.draw(probe.fit(), 1);
    const again = probe.pixel(400, 300, 1);
    return {
      first,
      centre,
      corner,
      hidden,
      cleared,
      oblique,
      again,
      error: probe.gl.getError(),
    };
  });
  expect(result.error).toBe(0);
  expect(red(result.centre)).toBe(true);
  expect(result.corner).toEqual(BACKGROUND);
  // The outline frame is the only other draw; a hidden material sends no indices.
  expect(result.first.indices).toBe(36 + 4 * 36);
  expect(result.hidden.indices).toBe(4 * 36);
  expect(result.cleared).toEqual(BACKGROUND);
  expect(red(result.again)).toBe(true);
});

test("the z scale stretches heights and highlights are drawn white on top", async ({
  page,
}) => {
  const size = { width: 800, height: 600 };
  // A tall thin post seen from the side; the pivot sits at its middle.
  await mountSolid(
    page,
    fixture([49000, 49000, 51000, 51000], 11),
    scripts,
    size,
  );
  const result = await page.evaluate(() => {
    const probe = window.solidProbe;
    const side = (zScale: number): SolidCamera => ({
      pivot: [50, 50, 6],
      azimuth: 0,
      elevation: 0,
      distance: 300,
      zScale,
    });
    const column = (zScale: number) => {
      probe.draw(side(zScale), 1);
      let count = 0;
      for (let y = 0; y < 600; y++) {
        const [r, g, b] = probe.pixel(400, y, 1);
        if (r! > 120 && g! < 40 && b! < 40) count++;
      }
      return count;
    };
    const once = column(1);
    const twice = column(2);
    const lid = window.SolidRenderer.highlightGeometry(
      probe.scene,
      new Map([[0, [49000, 49000, 51000, 51000]]]),
      [45000, 45000, 55000, 55000],
    );
    const top = window.SolidRenderer.topView(probe.fit());
    probe.draw(top, 1, lid);
    const white = probe.pixel(400, 300, 1);
    probe.draw(top, 1);
    const plain = probe.pixel(400, 300, 1);
    return { once, twice, white, plain, error: probe.gl.getError() };
  });
  expect(result.error).toBe(0);
  expect(result.once).toBeGreaterThan(20);
  expect(result.twice / result.once).toBeGreaterThan(1.8);
  expect(result.twice / result.once).toBeLessThan(2.2);
  expect(result.white.every((channel) => channel > 200)).toBe(true);
  expect(red(result.plain)).toBe(true);
});

test("a lost context pauses drawing and a restored one draws again", async ({
  page,
}) => {
  await mountSolid(page, fixture([40000, 40000, 60000, 60000]), scripts, {
    width: 800,
    height: 600,
  });
  await page.evaluate(() => {
    const probe = window.solidProbe;
    probe.draw(window.SolidRenderer.topView(probe.fit()), 1);
    const extension = probe.gl.getExtension("WEBGL_lose_context")!;
    probe.restoreContext = () => extension.restoreContext();
    extension.loseContext();
  });
  await expect
    .poll(() => page.evaluate(() => window.solidProbe.contextLost))
    .toBe(true);
  expect(
    await page.evaluate(() => {
      const probe = window.solidProbe;
      return probe.draw(window.SolidRenderer.topView(probe.fit()), 1).calls;
    }),
  ).toBe(0);
  await page.evaluate(() => window.solidProbe.restoreContext());
  await expect
    .poll(() => page.evaluate(() => window.solidProbe.contextLost))
    .toBe(false);
  expect(
    red(
      await page.evaluate(() => {
        const probe = window.solidProbe;
        probe.draw(window.SolidRenderer.topView(probe.fit()), 1);
        return probe.pixel(400, 300, 1);
      }),
    ),
  ).toBe(true);
});
