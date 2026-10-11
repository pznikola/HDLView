// Browser-only diagnostics for the 3D view renderer, shared by its regressions
// and benchmark. Compile the production modules with the compiler already
// supplied by Vite.
import { build } from "esbuild";

export async function solidScripts() {
  const options = { bundle: true, write: false, format: "iife" };
  const [renderer, worker] = await Promise.all([
    build({
      ...options,
      stdin: {
        contents: 'export * from "./ui/gl-solid.ts";',
        resolveDir: process.cwd(),
      },
      globalName: "SolidRenderer",
    }),
    build({ ...options, entryPoints: ["ui/solid.worker.ts"] }),
  ]);
  return {
    renderer: renderer.outputFiles[0].text,
    worker: worker.outputFiles[0].text,
  };
}

export async function mountSolid(
  page,
  data,
  scripts,
  size = { width: 1100, height: 700 },
) {
  await page.evaluate(() => window.solidProbe?.renderer.dispose());
  await page.setContent(
    '<style>body{margin:0;background:#0e1720}</style><canvas aria-label="3D"></canvas>',
  );
  await page.addScriptTag({ content: scripts.renderer });
  return page.evaluate(
    async ({ data, workerCode, size }) => {
      const canvas = document.querySelector("canvas");
      canvas.style.width = `${size.width}px`;
      canvas.style.height = `${size.height}px`;
      let contextLost = false;
      const renderer = SolidRenderer.createSolidRenderer(canvas, (lost) => {
        contextLost = lost;
      });
      if (!renderer) throw new Error("WebGL2 is unavailable");
      const gl = canvas.getContext("webgl2");
      let calls = 0,
        indices = 0;
      const draw = gl.drawElementsInstanced.bind(gl);
      gl.drawElementsInstanced = (...args) => {
        calls++;
        indices += args[1] * args[4];
        draw(...args);
      };
      const url = URL.createObjectURL(
        new Blob([workerCode], { type: "text/javascript" }),
      );
      const worker = new Worker(url);
      const started = performance.now();
      const scene = await new Promise((resolve, reject) => {
        worker.onmessage = ({ data }) =>
          "error" in data ? reject(new Error(data.error)) : resolve(data.scene);
        worker.onerror = (event) => reject(new Error(event.message));
        worker.postMessage(data);
      }).finally(() => {
        worker.terminate();
        URL.revokeObjectURL(url);
      });
      const preparationMs = performance.now() - started;
      const viewport = (ratio) => ({
        width: size.width,
        height: size.height,
        pixelWidth: Math.max(1, Math.round(size.width * ratio)),
        pixelHeight: Math.max(1, Math.round(size.height * ratio)),
      });
      window.solidProbe = {
        scene,
        canvas,
        gl,
        renderer,
        hidden: new Set(),
        size,
        get contextLost() {
          return contextLost;
        },
        fit(zScale = 1) {
          return SolidRenderer.fitSolid(
            scene.box.map((v) => v / scene.dbu),
            scene.zRange,
            size.width / size.height,
            zScale,
          );
        },
        draw(camera, ratio = devicePixelRatio, highlight) {
          calls = indices = 0;
          const started = performance.now();
          renderer.draw(scene, camera, viewport(ratio), this.hidden, highlight);
          return { cpuMs: performance.now() - started, calls, indices };
        },
        /** The colour of a CSS pixel, y from the top, after the last draw. */
        pixel(x, y, ratio = devicePixelRatio) {
          const out = new Uint8Array(4);
          gl.readPixels(
            Math.round(x * ratio),
            Math.round((size.height - y) * ratio) - 1,
            1,
            1,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            out,
          );
          return [...out.subarray(0, 3)];
        },
        async complete() {
          const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
          gl.flush();
          let status;
          const start = performance.now();
          do {
            status = gl.clientWaitSync(fence, 0, 0);
            if (status === gl.WAIT_FAILED)
              throw new Error("GPU completion wait failed");
            if (performance.now() - start > 30000)
              throw new Error("GPU completion timed out");
            if (status === gl.TIMEOUT_EXPIRED)
              await new Promise((resolve) => setTimeout(resolve, 0));
          } while (status === gl.TIMEOUT_EXPIRED);
          gl.deleteSync(fence);
        },
      };
      const debug = gl.getExtension("WEBGL_debug_renderer_info");
      return {
        preparationMs,
        triangles: scene.triangles,
        renderer: debug
          ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
          : gl.getParameter(gl.RENDERER),
      };
    },
    { data, workerCode: scripts.worker, size },
  );
}
