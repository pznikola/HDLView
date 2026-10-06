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
    const graph = {
      nodes: [],
      edges: [],
      signals: [],
      truncated: false,
      total_cells: 1000,
    };
    for (let i = 0; i < 1000; i++) {
      graph.nodes.push({
        id: `n${i}`,
        label: `cell${i}`,
        kind: "$and",
        ports: [
          { id: `n${i}:A`, direction: "input" },
          { id: `n${i}:Y`, direction: "output" },
        ],
      });
      if (i)
        graph.edges.push({
          id: `e${i}`,
          sources: [`n${Math.floor((i - 1) / 2)}:Y`],
          targets: [`n${i}:A`],
          label: "",
        });
    }
    const worker = new Worker(`/assets/${workerFile}`, { type: "module" });
    const start = performance.now();
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error("layout timeout"));
      }, 60000);
      worker.onmessage = ({ data }) => {
        clearTimeout(timer);
        worker.terminate();
        data.error
          ? reject(new Error(data.error))
          : resolve({
              nodes: 1000,
              edges: 999,
              layout_ms: performance.now() - start,
            });
      };
      worker.onerror = (error) => {
        clearTimeout(timer);
        worker.terminate();
        reject(new Error(error.message));
      };
      worker.postMessage({ sequence: 1, graph });
    });
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
