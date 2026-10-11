// node tools/benchmark-solid.mjs /path/to/layout_solid.json [--headed]
import { chromium } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { solidScripts, mountSolid } from "./solid-browser.mjs";

const path = process.argv[2];
if (!path)
  throw new Error(
    "Usage: node tools/benchmark-solid.mjs layout_solid.json [--headed]",
  );
const data = JSON.parse(await readFile(path, "utf8"));
const browser = await chromium.launch({
  headless: !process.argv.includes("--headed"),
  ...(process.argv.includes("--headed")
    ? { args: ["--use-gl=angle", "--use-angle=gl"] }
    : {}),
});
try {
  const page = await browser.newPage({
    viewport: { width: 1100, height: 700 },
  });
  const setup = await mountSolid(page, data, await solidScripts());
  const result = await page.evaluate(async () => {
    const probe = window.solidProbe;
    const fitted = probe.fit();
    const workloads = [];
    const gl = probe.gl;
    const timer = gl.getExtension("EXT_disjoint_timer_query_webgl2");
    // Orbiting the whole scene, a close oblique look and the top view, each
    // moving a little every frame as a drag would.
    for (const [name, base, step] of [
      ["fit", fitted, (camera, i) => SolidRenderer.orbit(camera, i * 2, 0)],
      [
        "close",
        SolidRenderer.dolly(fitted, 0.08),
        (camera, i) => SolidRenderer.orbit(camera, i * 2, i * 0.5),
      ],
      [
        "top",
        SolidRenderer.dolly(SolidRenderer.topView(fitted), 0.5),
        (camera, i) =>
          SolidRenderer.pan(camera, i * 2, 0, {
            width: probe.size.width,
            height: probe.size.height,
          }),
      ],
    ]) {
      const frames = [];
      const queries = [];
      let previous;
      for (let i = 0; i < 65; i++) {
        const timestamp = await new Promise((resolve) =>
          requestAnimationFrame(resolve),
        );
        const camera = step(base, i);
        const query = timer ? gl.createQuery() : null;
        if (query) gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
        const start = performance.now();
        const counters = probe.draw(camera);
        if (query) gl.endQuery(timer.TIME_ELAPSED_EXT);
        queries.push(query);
        const frame = {
          ...counters,
          intervalMs: previous === undefined ? null : timestamp - previous,
        };
        if (i === 0) {
          await probe.complete();
          frame.completeMs = performance.now() - start;
        }
        frames.push(frame);
        previous = timestamp;
      }
      const drain = performance.now();
      await probe.complete();
      const queueDrainMs = performance.now() - drain;
      const disjoint = timer && gl.getParameter(timer.GPU_DISJOINT_EXT);
      queries.forEach((query, i) => {
        frames[i].gpuMs =
          query &&
          !disjoint &&
          gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)
            ? gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6
            : null;
        if (query) gl.deleteQuery(query);
      });
      const steady = frames.slice(5);
      const percentile = (key, p) => {
        const values = steady
          .map((f) => f[key])
          .filter((v) => v !== null)
          .sort((a, b) => a - b);
        return values[Math.ceil(values.length * p) - 1] ?? null;
      };
      workloads.push({
        name,
        firstFrame: frames[0],
        cpuP50Ms: percentile("cpuMs", 0.5),
        cpuP95Ms: percentile("cpuMs", 0.95),
        frameP50Ms: percentile("intervalMs", 0.5),
        frameP95Ms: percentile("intervalMs", 0.95),
        gpuP50Ms: percentile("gpuMs", 0.5),
        gpuP95Ms: percentile("gpuMs", 0.95),
        trianglesP50: percentile("indices", 0.5) / 3,
        queueDrainMs,
      });
    }
    return { workloads, glError: gl.getError() };
  });
  const report = { input: path, ...setup, ...result };
  await mkdir(".hdlview/benchmarks", { recursive: true });
  await writeFile(
    ".hdlview/benchmarks/solid-result.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
