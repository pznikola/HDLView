import { mkdir, copyFile } from "node:fs/promises";
await mkdir("public/vendor", { recursive: true });
await copyFile(
  "node_modules/elkjs/lib/elk-worker.min.js",
  "public/vendor/elk-worker.min.js",
);
await copyFile("node_modules/elkjs/lib/elk-api.js", "public/vendor/elk-api.js");

await copyFile("node_modules/elkjs/LICENSE.md", "public/vendor/ELK-LICENSE.md");
