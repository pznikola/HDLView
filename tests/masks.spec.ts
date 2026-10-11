import { test, expect } from "@playwright/test";
import { maskScripts, mountMasks } from "../tools/mask-browser.mjs";
import type { Camera } from "../ui/floorplan";
import type { MaskData } from "../ui/types";
import { orientation } from "../ui/masks";

declare global {
  interface Window {
    maskProbe: {
      gl: WebGL2RenderingContext;
      hidden: Set<string>;
      contextLost: boolean;
      restoreContext(): void;
      size: { width: number; height: number };
      draw(
        camera: Camera,
        ratio?: number,
      ): { indices: number; allocations: number; uploadBytes: number };
      projectVertices(count: number): number[];
    };
  }
}
let scripts: { renderer: string; worker: string };
test.beforeAll(async () => {
  scripts = await maskScripts();
});
const layer = {
  name: "metal",
  source: "1/0",
  fill: "#ffffff",
  frame: "#ffffff",
  pattern: ["*"],
  visible: true,
  offset: 0,
};
const fixture = (): MaskData => ({
  dbu: 1000,
  top: "top",
  box: [0, 0, 100000000, 100000000],
  layers: [layer],
  cells: [],
  instances: [],
  shapes: [],
  labels: [],
});

for (const origin of [-90000001, 90000001, 2147483001]) {
  test(`projected GDS edges retain subpixel accuracy near ${origin} DBU`, async ({
    page,
  }) => {
    const vertices = [
      [2, 0],
      [102, 0],
      [102, 50],
      [2, 50],
    ];
    const size = { width: 403, height: 307 };
    for (let code = 0; code < 8; code++) {
      const [a, b, c, d] = orientation(code);
      const world = vertices.map(([x, y]) => [
        origin + a! * x! + c! * y!,
        origin + b! * x! + d! * y!,
      ]);
      for (const kind of ["top", "cell"]) {
        const masks = fixture();
        if (kind === "top")
          masks.shapes = [{ boxes: [], polygons: [world.flat()] }];
        else {
          masks.cells = [
            {
              name: "leaf",
              box: [2, 0, 102, 50],
              layers: { "0": { boxes: [2, 0, 102, 50], polygons: [] } },
            },
          ];
          masks.instances = [[0, origin, origin, code]];
        }
        await mountMasks(page, masks, scripts, size, true);
        const errors = await page.evaluate(
          ({ world, origin }) => {
            const probe = window.maskProbe;
            let worst = 0;
            for (const ratio of [1, 1.25, 1.5, 2]) {
              for (const scale of [0.01, 1, 40, 2000]) {
                for (let pan = 0; pan <= 10; pan++) {
                  const camera = {
                    x: origin / 1000 - 0.06 + pan * 0.000125,
                    y: origin / 1000 + 0.09,
                    scale,
                  };
                  probe.draw(camera, ratio);
                  const positions = probe.projectVertices(4);
                  for (let v = 0; v < 4; v++) {
                    const expected = [
                      (world[v]![0]! / 1000 - camera.x) * scale,
                      (camera.y - world[v]![1]! / 1000) * scale,
                    ];
                    const actual = [
                      ((positions[v * 4]! + 1) * probe.size.width) / 2,
                      ((1 - positions[v * 4 + 1]!) * probe.size.height) / 2,
                    ];
                    worst = Math.max(
                      worst,
                      Math.abs(expected[0]! - actual[0]!) * ratio,
                      Math.abs(expected[1]! - actual[1]!) * ratio,
                    );
                  }
                }
              }
            }
            return { worst, error: probe.gl.getError() };
          },
          { world, origin },
        );
        expect(errors.error).toBe(0);
        expect(errors.worst, `${kind}, orientation ${code}`).toBeLessThan(0.25);
      }
    }
  });
}

test("rendered edges move together, return exactly, and survive visibility and context changes", async ({
  page,
}) => {
  const masks = fixture();
  masks.cells = [
    {
      name: "leaf",
      box: [2, 0, 102, 50],
      layers: { "0": { boxes: [2, 0, 102, 50], polygons: [] } },
    },
  ];
  masks.instances = [[0, 90000001, 600, 0]];
  masks.shapes = [{ boxes: [90000003, 500, 90000103, 550], polygons: [] }];
  const setup = await mountMasks(page, masks, scripts, {
    width: 400,
    height: 600,
  });
  expect(setup.antialias).toBe(true);
  const result = await page.evaluate(() => {
    const probe = window.maskProbe,
      gl = probe.gl;
    const sample = (y: number) => {
      const row = new Uint8Array(1600);
      gl.readPixels(0, y, 400, 1, gl.RGBA, gl.UNSIGNED_BYTE, row);
      return Array.from({ length: 400 }, (_, i) => i).find(
        (i) => row[i * 4]! > 128,
      );
    };
    const camera = { x: 89999.95, y: 0.7, scale: 2000 };
    const edges = [];
    probe.draw(camera);
    const first = sample(250);
    for (let i = 0; i < 10; i++) {
      probe.draw({ ...camera, x: camera.x + i * 0.001 });
      edges.push([sample(250), sample(450)]);
    }
    const warm = probe.draw(camera);
    const returned = sample(250);
    probe.hidden.add("1/0");
    const hidden = probe.draw(camera);
    probe.hidden.clear();
    probe.draw(camera);
    return { first, returned, edges, warm, hidden, error: gl.getError() };
  });
  expect(result.error).toBe(0);
  expect(result.returned).toBe(result.first);
  for (let i = 0; i < result.edges.length; i++) {
    expect(result.edges[i]![0]).toBe(result.edges[i]![1]);
    expect(result.edges[i]![0]).toBe(result.first! - i * 2);
  }
  expect(result.warm.allocations).toBe(0);
  expect(result.hidden.indices).toBe(0);
  await page.evaluate(() => {
    const extension = window.maskProbe.gl.getExtension("WEBGL_lose_context")!;
    window.maskProbe.restoreContext = () => extension.restoreContext();
    extension.loseContext();
  });
  await expect
    .poll(() => page.evaluate(() => window.maskProbe.contextLost))
    .toBe(true);
  await page.evaluate(() => window.maskProbe.restoreContext());
  await expect
    .poll(() => page.evaluate(() => window.maskProbe.contextLost))
    .toBe(false);
  expect(
    await page.evaluate(() => {
      const probe = window.maskProbe;
      probe.draw({ x: 89999.95, y: 0.7, scale: 2000 });
      const pixels = new Uint8Array(1600);
      probe.gl.readPixels(
        0,
        250,
        400,
        1,
        probe.gl.RGBA,
        probe.gl.UNSIGNED_BYTE,
        pixels,
      );
      return Array.from({ length: 400 }, (_, i) => i).find(
        (i) => pixels[i * 4]! > 128,
      );
    }),
  ).toBe(result.first);
});

test("two-DBU gaps stay open in cells with large local coordinates and every orientation", async ({
  page,
}) => {
  const origin = 90000001;
  for (let code = 0; code < 8; code++) {
    const masks = fixture();
    masks.cells = [
      {
        name: "offset",
        box: [origin, 0, origin + 202, 100],
        layers: {
          "0": {
            boxes: [
              origin,
              0,
              origin + 100,
              100,
              origin + 102,
              0,
              origin + 202,
              100,
            ],
            polygons: [],
          },
        },
      },
    ];
    masks.instances = [[0, 7, -13, code]];
    await mountMasks(page, masks, scripts, { width: 400, height: 400 });
    const [a, b, c, d] = orientation(code);
    const centre = [
      a * (origin + 101) + c * 50 + 7,
      b * (origin + 101) + d * 50 - 13,
    ];
    const samples = await page.evaluate(
      ({ centre, a, b }) => {
        const probe = window.maskProbe,
          gl = probe.gl;
        const out = [];
        for (const pan of [0, 0.25, 0.5, 0.75, 0]) {
          probe.draw({
            x: centre[0]! / 1000 - 0.1 + pan / 2000,
            y: centre[1]! / 1000 + 0.1,
            scale: 2000,
          });
          const sample = (distance: number) => {
            const pixel = new Uint8Array(4);
            gl.readPixels(
              Math.floor(200 - pan) + distance * a,
              200 + distance * b,
              1,
              1,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              pixel,
            );
            return pixel[0];
          };
          out.push([sample(-6), sample(0), sample(6)]);
        }
        return out;
      },
      { centre, a, b },
    );
    for (const [left, gap, right] of samples) {
      expect(left).toBeGreaterThan(200);
      expect(gap).toBeLessThan(30);
      expect(right).toBeGreaterThan(200);
    }
  }
});
