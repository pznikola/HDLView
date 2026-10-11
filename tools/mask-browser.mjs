// Browser-only diagnostics shared by renderer regressions and the mask benchmark.
// Compile the production modules with the compiler already supplied by Vite.
import { build } from "esbuild";

export async function maskScripts() {
  const options = { bundle: true, write: false, format: "iife" };
  const [renderer, worker] = await Promise.all([
    build({
      ...options,
      stdin: {
        contents: 'export * from "./ui/gl-layout.ts";',
        resolveDir: process.cwd(),
      },
      globalName: "MaskRenderer",
    }),
    build({ ...options, entryPoints: ["ui/masks.worker.ts"] }),
  ]);
  return {
    renderer: renderer.outputFiles[0].text,
    worker: worker.outputFiles[0].text,
  };
}

export async function mountMasks(
  page,
  masks,
  scripts,
  size = { width: 1100, height: 700 },
  feedback = false,
) {
  await page.evaluate(() => window.maskProbe?.renderer.dispose());
  await page.setContent(
    '<style>body{margin:0;background:#0e1720}</style><canvas aria-label="Masks"></canvas>',
  );
  await page.addScriptTag({ content: scripts.renderer });
  return page.evaluate(
    async ({ masks, workerCode, size, feedback }) => {
      const canvas = document.querySelector("canvas");
      canvas.style.width = `${size.width}px`;
      canvas.style.height = `${size.height}px`;
      let contextLost = false;
      const renderer = MaskRenderer.createRenderer(canvas, (lost) => {
        contextLost = lost;
      });
      if (!renderer) throw new Error("WebGL2 is unavailable");
      const gl = canvas.getContext("webgl2");
      let lastDraw;
      let calls = 0,
        indices = 0,
        bytes = 0,
        allocations = 0;
      const draw = gl.drawElementsInstanced.bind(gl);
      gl.drawElementsInstanced = (...args) => {
        calls++;
        indices += args[1] * args[4];
        if (feedback)
          lastDraw = {
            vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
            program: gl.getParameter(gl.CURRENT_PROGRAM),
          };
        draw(...args);
      };
      // Enabled only for the precision regression; these varyings run the actual
      // production vertex shader against its actual buffers and uniforms.
      if (feedback) {
        const link = gl.linkProgram.bind(gl);
        gl.linkProgram = (program) => {
          gl.transformFeedbackVaryings(
            program,
            ["gl_Position"],
            gl.INTERLEAVED_ATTRIBS,
          );
          link(program);
        };
      }
      const allocate = gl.bufferData.bind(gl),
        upload = gl.bufferSubData.bind(gl);
      gl.bufferData = (...args) => {
        allocations++;
        bytes +=
          typeof args[1] === "number" ? args[1] : (args[1]?.byteLength ?? 0);
        allocate(...args);
      };
      gl.bufferSubData = (...args) => {
        bytes += args[2].byteLength;
        upload(...args);
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
        worker.postMessage(masks);
      }).finally(() => {
        worker.terminate();
        URL.revokeObjectURL(url);
      });
      const preparationMs = performance.now() - started;
      const hidden = new Set(
        masks.layers.filter((l) => !l.visible).map((l) => l.source),
      );
      window.maskProbe = {
        scene,
        started,
        canvas,
        gl,
        renderer,
        hidden,
        size,
        get contextLost() {
          return contextLost;
        },
        draw(camera, ratio = devicePixelRatio) {
          calls = indices = bytes = allocations = 0;
          const started = performance.now();
          renderer.draw(
            scene,
            camera,
            MaskRenderer.viewportSize(size.width, size.height, ratio),
            hidden,
          );
          return {
            cpuMs: performance.now() - started,
            calls,
            indices,
            uploadBytes: bytes,
            allocations,
          };
        },
        projectVertices(count) {
          const buffer = gl.createBuffer(),
            transform = gl.createTransformFeedback();
          gl.bindVertexArray(lastDraw.vao);
          gl.useProgram(lastDraw.program);
          gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, transform);
          gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, buffer);
          gl.bufferData(
            gl.TRANSFORM_FEEDBACK_BUFFER,
            count * 16,
            gl.STREAM_READ,
          );
          gl.enable(gl.RASTERIZER_DISCARD);
          gl.beginTransformFeedback(gl.POINTS);
          gl.drawArraysInstanced(gl.POINTS, 0, count, 1);
          gl.endTransformFeedback();
          gl.disable(gl.RASTERIZER_DISCARD);
          const result = new Float32Array(count * 4);
          gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, 0, result);
          gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
          gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
          gl.bindVertexArray(null);
          gl.deleteBuffer(buffer);
          gl.deleteTransformFeedback(transform);
          return [...result];
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
        renderer: debug
          ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
          : gl.getParameter(gl.RENDERER),
        antialias: gl.getContextAttributes().antialias,
      };
    },
    { masks, workerCode: scripts.worker, size, feedback },
  );
}
