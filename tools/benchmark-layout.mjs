// Run after npm run build. Measures the actual browser worker, not a Node substitute.
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
const root = resolve("dist");
const server = createServer(async (request, response) => {
  const path = resolve(
    root,
    "." + new URL(request.url, "http://localhost").pathname,
  );
  if (!path.startsWith(root + "/")) {
    response.writeHead(404).end();
    return;
  }
  try {
    response.setHeader(
      "Content-Type",
      { ".js": "text/javascript", ".html": "text/html", ".css": "text/css" }[
        extname(path)
      ] || "application/octet-stream",
    );
    response.end(await readFile(path));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  const workerFile = (await readdir("dist/assets")).find((name) =>
    name.startsWith("layout.worker-"),
  );
  const result = await page.evaluate(async (workerFile) => {
    const results = [];
    // Quality figures for comparing layout changes; they are recorded, not asserted.
    const quality = (view) => {
      const horizontal = [],
        vertical = [];
      let wire_length = 0;
      for (const wire of view.wires)
        for (const path of wire.paths) {
          const points = [...path.d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map(
            (m) => [Number(m[1]), Number(m[2])],
          );
          for (let i = 1; i < points.length; i++) {
            const [ax, ay] = points[i - 1],
              [bx, by] = points[i];
            wire_length += Math.abs(bx - ax) + Math.abs(by - ay);
            if (ay === by)
              horizontal.push([
                wire.edge_id,
                ay,
                Math.min(ax, bx),
                Math.max(ax, bx),
              ]);
            else
              vertical.push([
                wire.edge_id,
                ax,
                Math.min(ay, by),
                Math.max(ay, by),
              ]);
          }
        }
      let crossings = 0;
      for (const [a, y, left, right] of horizontal)
        for (const [b, x, top, bottom] of vertical)
          if (a !== b && left < x && x < right && top < y && y < bottom)
            crossings++;
      return {
        bends: view.graph.edges.reduce(
          (sum, edge) =>
            sum +
            (edge.sections ?? []).reduce(
              (n, section) => n + (section.bendPoints?.length ?? 0),
              0,
            ),
          0,
        ),
        crossings,
        wire_length: Math.round(wire_length),
        width: Math.round(view.graph.width),
        height: Math.round(view.graph.height),
      };
    };
    // "memory" is words of write multiplexer and register read through a
    // multiplexer tree, the shape of a small RAM mapped to flip-flops.
    for (const [pattern, count] of [
      ["mixed_balanced", 1000],
      ["high_fanout", 1000],
      ["memory", 2500],
      ["memory", 5000],
    ]) {
      const words = Math.floor(count / 3);
      const graph = {
        nodes: [],
        edges: [],
        signals: [],
        truncated: false,
        total_cells: count,
        hidden_physical_cells: 0,
        omitted_cells: 0,
      };
      const pin = (id, direction, role = "data") => ({
        id,
        label: id.split(":").at(-1),
        direction,
        signal_ids: [id],
        display: {
          name: id.split(":").at(-1),
          width: 1,
          bits: [id],
          role,
          polarity: true,
          asynchronous: false,
        },
      });
      const cells = pattern === "memory" ? 3 * words - 1 : count;
      for (let i = 0; i < cells; i++) {
        const symbol =
          pattern === "mixed_balanced"
            ? ["and", "mux", "register", "operator"][i % 4]
            : pattern === "memory"
              ? i >= words && i < 2 * words
                ? "register"
                : "mux"
              : "and";
        const input = symbol === "register" ? "D" : "A";
        graph.nodes.push({
          id: `n${i}`,
          label: `cell${i}`,
          kind: symbol,
          child_scope: null,
          source: null,
          display: {
            symbol,
            title: symbol === "operator" ? "+" : symbol.toUpperCase(),
            annotations: [],
            members: [],
            internal_signal_ids: [],
          },
          ports: [
            pin(`n${i}:${input}`, "input"),
            ...(symbol === "register"
              ? [
                  pin(`n${i}:CLK`, "input", "clock"),
                  pin(`n${i}:RESET`, "input", "reset"),
                ]
              : [
                  pin(`n${i}:B`, "input"),
                  ...(symbol === "mux"
                    ? [pin(`n${i}:S`, "input", "select")]
                    : []),
                ]),
            pin(`n${i}:Y`, "output"),
          ],
        });
        if (pattern === "memory") {
          // Cells 0..words are write multiplexers, then registers, then the tree.
          const net = (source, targets) =>
            graph.edges.push({
              id: `e${graph.edges.length}`,
              sources: [`n${source}:Y`],
              targets,
              signal_ids: [`e${graph.edges.length}`],
              label: "",
              bits: [graph.edges.length + 2],
            });
          if (i < words) net(i, [`n${words + i}:D`]);
          else if (i < 2 * words) {
            // Leaves of the tree are the registers, two per multiplexer.
            const leaf = words - 1 + (i - words),
              parent = 2 * words + Math.floor((leaf - 1) / 2);
            net(i, [`n${i - words}:A`, `n${parent}:${leaf % 2 ? "A" : "B"}`]);
          } else if (i > 2 * words) {
            const j = i - 2 * words;
            net(i, [
              `n${2 * words + Math.floor((j - 1) / 2)}:${j % 2 ? "A" : "B"}`,
            ]);
          }
        } else if (i)
          graph.edges.push({
            id: `e${i}`,
            sources: [
              `n${pattern === "high_fanout" ? 0 : Math.floor((i - 1) / 2)}:Y`,
            ],
            targets: [`n${i}:${input}`],
            signal_ids: [`e${i}`],
            label: "",
            bits: [i + 2],
          });
      }
      const worker = new Worker(`/assets/${workerFile}`, { type: "module" });
      let start = performance.now();
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          worker.terminate();
          reject(new Error("layout timeout"));
        }, 60000);
        // The application keeps its worker; the second run is what navigation costs.
        let layout_ms;
        worker.onmessage = ({ data }) => {
          if (!data.error && layout_ms === undefined) {
            layout_ms = performance.now() - start;
            start = performance.now();
            worker.postMessage({ sequence: 2, graph });
            return;
          }
          clearTimeout(timer);
          worker.terminate();
          data.error
            ? reject(new Error(data.error))
            : resolve({
                pattern,
                nodes: graph.nodes.length,
                edges: graph.edges.length,
                layout_ms,
                repeat_layout_ms: performance.now() - start,
                ...quality(data.result),
              });
        };
        worker.onerror = (error) => {
          clearTimeout(timer);
          worker.terminate();
          reject(new Error(error.message));
        };
        worker.postMessage({ sequence: 1, graph });
      });
      results.push(result);
    }
    return results;
  }, workerFile);
  await mkdir(".hdlview/benchmarks", { recursive: true });
  await writeFile(
    ".hdlview/benchmarks/layout-result.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
  server.close();
}
