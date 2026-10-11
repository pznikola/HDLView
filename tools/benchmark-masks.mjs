// node tools/benchmark-masks.mjs /path/to/layout_masks.json [--headed]
import { chromium } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { maskScripts, mountMasks } from "./mask-browser.mjs";

const path = process.argv[2];
if (!path)
  throw new Error(
    "Usage: node tools/benchmark-masks.mjs masks.json [--headed]",
  );
const masks = JSON.parse(await readFile(path, "utf8"));
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
  const setup = await mountMasks(page, masks, await maskScripts());
  const result = await page.evaluate(async () => {
    const probe = window.maskProbe;
    const { scene, size } = probe;
    const box = scene.box.map((v) => v / scene.dbu);
    const scale = Math.min(
      (size.width - 120) / (box[2] - box[0]),
      (size.height - 120) / (box[3] - box[1]),
    );
    const centre = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
    const workloads = [];
    const gl = probe.gl;
    const timer = gl.getExtension("EXT_disjoint_timer_query_webgl2");
    for (const [name, zoom] of [
      ["fit", scale],
      ["detail", 40],
      ["deep", 2000],
    ]) {
      const frames = [];
      const queries = [];
      let previous;
      for (let i = 0; i < 65; i++) {
        const timestamp = await new Promise((resolve) =>
          requestAnimationFrame(resolve),
        );
        const camera = {
          x: centre[0] - size.width / 2 / zoom + (i * 0.25) / zoom,
          y: centre[1] + size.height / 2 / zoom,
          scale: zoom,
        };
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
        // First-frame latency includes GPU completion; steady motion never waits
        // synchronously for the GPU, just as in the application.
        if (i === 0) {
          await probe.complete();
          frame.completeMs = performance.now() - start;
          if (name === "fit")
            frame.firstVisibleMs = performance.now() - probe.started;
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
        queueDrainMs,
        lastFrame: frames.at(-1),
      });
    }
    return { workloads, glError: probe.gl.getError() };
  });
  const report = { input: path, ...setup, ...result };
  await mkdir(".hdlview/benchmarks", { recursive: true });
  await writeFile(
    ".hdlview/benchmarks/masks-result.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
