import { type Camera, visibleBox } from "./floorplan";
import { orientation } from "./masks";
import {
  expandedBox,
  querySpatial,
  splitCoordinate,
  type Geometry,
  type MaskScene,
} from "./mask-scene";
import type { MaskLayer } from "./types";

export const MAX_LAYERS = 64;
const PATTERN_SIZE = 32;

/** Width and height of a layer's bitmap; a row without pixels is left out. */
export function patternSize(layer: MaskLayer): [number, number] {
  const rows = layer.pattern.filter((row) => row.length);
  return [Math.max(0, ...rows.map((row) => row.length)), rows.length];
}
/**
 * Whether a device pixel is set, as KLayout tiles a bitmap: `y` counts from
 * the bottom of the canvas, rows repeat from the bottom row up, and a layer's
 * position in the layer file shifts the rows.
 */
export function patternBit(layer: MaskLayer, x: number, y: number): boolean {
  const rows = layer.pattern.filter((row) => row.length);
  const [width, height] = patternSize(layer);
  if (!width) return false;
  const row = rows[height - 1 - ((y + layer.offset) % height)]!;
  return row[x % width] === "*";
}
/** Every layer's bitmap in one texture, `PATTERN_SIZE` rows each, bottom row first. */
export function patternAtlas(layers: MaskLayer[]): Uint8Array {
  const atlas = new Uint8Array(PATTERN_SIZE * PATTERN_SIZE * layers.length);
  layers.forEach((layer, index) => {
    const rows = layer.pattern.filter((row) => row.length);
    rows.forEach((row, number) => {
      const y = rows.length - 1 - number;
      for (let x = 0; x < row.length && x < PATTERN_SIZE; x++)
        if (row[x] === "*" && y < PATTERN_SIZE)
          atlas[(index * PATTERN_SIZE + y) * PATTERN_SIZE + x] = 255;
    });
  });
  return atlas;
}

const SHAPE_VERTEX = `#version 300 es
layout(location=0) in vec4 a_position;
layout(location=1) in float a_layer;
layout(location=2) in vec4 a_place;
layout(location=3) in float a_code;
uniform mat2 u_orientation[8];
uniform float u_scale;
uniform vec2 u_viewport;
uniform float u_layers;
flat out int v_layer;
void main() {
  mat2 orientation = u_orientation[int(a_code)];
  // Cancel the large parts before adding the remainders. The placement has
  // already had the camera subtracted in double precision on the CPU.
  vec2 high = orientation * a_position.xy + a_place.xy;
  vec2 low = orientation * a_position.zw + a_place.zw;
  vec2 px = (high + low) * u_scale;
  gl_Position = vec4(px.x / u_viewport.x * 2.0 - 1.0,
    px.y / u_viewport.y * 2.0 + 1.0,
    1.0 - (a_layer + 1.0) / (u_layers + 2.0), 1.0);
  v_layer = int(a_layer);
}`;
const SHAPE_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
flat in int v_layer;
uniform vec4 u_fill[${MAX_LAYERS}];
uniform vec4 u_frame[${MAX_LAYERS}];
uniform ivec4 u_pattern[${MAX_LAYERS}];
uniform sampler2D u_atlas;
uniform bool u_lines;
out vec4 colour;
void main() {
  if (u_lines) {
    colour = vec4(u_frame[v_layer].rgb, 1.0);
    return;
  }
  ivec4 pattern = u_pattern[v_layer];
  if (pattern.x == 0) discard;
  int x = int(gl_FragCoord.x) % pattern.x;
  int y = (int(gl_FragCoord.y) + pattern.z) % pattern.y;
  if (texelFetch(u_atlas, ivec2(x, v_layer * ${PATTERN_SIZE} + y), 0).r < 0.5) discard;
  colour = vec4(u_fill[v_layer].rgb, 1.0);
}`;

function rgb(hex: string): [number, number, number] {
  const value = parseInt(hex.replace("#", ""), 16);
  return [
    ((value >> 16) & 255) / 255,
    ((value >> 8) & 255) / 255,
    (value & 255) / 255,
  ];
}

export interface Viewport {
  width: number;
  height: number;
  pixelWidth: number;
  pixelHeight: number;
}
export function viewportSize(
  width: number,
  height: number,
  ratio: number,
): Viewport {
  return {
    width,
    height,
    pixelWidth: Math.max(1, Math.round(width * ratio)),
    pixelHeight: Math.max(1, Math.round(height * ratio)),
  };
}

/** Only index buffers change when visibility changes; geometry stays on the GPU. */
export function visibleIndices(
  mesh: Geometry,
  shown: boolean[],
  lines: boolean,
): Uint32Array {
  const source = lines ? mesh.frame : mesh.fill;
  const ranges = mesh.ranges.filter((range) => shown[range.layer]);
  const count = ranges.reduce(
    (n, r) => n + (lines ? r.frameCount : r.fillCount),
    0,
  );
  const out = new Uint32Array(count);
  let offset = 0;
  for (const range of ranges) {
    const start = lines ? range.frameStart : range.fillStart;
    const size = lines ? range.frameCount : range.fillCount;
    out.set(source.subarray(start, start + size), offset);
    offset += size;
  }
  return out;
}

interface InstanceBuffer {
  buffer: WebGLBuffer;
  data: Float32Array;
  count: number;
  capacity: number;
}
interface MeshBuffer {
  vao: WebGLVertexArrayObject;
  vertices: WebGLBuffer;
  fill: WebGLBuffer;
  frame: WebGLBuffer;
  fillCount: number;
  frameCount: number;
}
interface Loaded {
  scene: MaskScene;
  cells: MeshBuffer[];
  top: MeshBuffer[];
  instances: InstanceBuffer[];
  origin: InstanceBuffer;
  atlas: WebGLTexture;
  visibility: string;
}
export interface LayoutRenderer {
  draw(
    scene: MaskScene,
    camera: Camera,
    viewport: Viewport,
    hidden: ReadonlySet<string>,
  ): void;
  dispose(): void;
}

/** Allocation failure is a renderer error, never an apparently empty layout. */
function allocated<T>(value: T | null): T {
  if (value === null) throw new Error("Cannot allocate layout GPU resources");
  return value;
}

export function createRenderer(
  canvas: HTMLCanvasElement,
  onContextChange: (lost: boolean) => void = () => {},
): LayoutRenderer | undefined {
  const context = canvas.getContext("webgl2", {
    antialias: true,
    alpha: false,
  });
  if (!context) return undefined;
  const gl = context;
  let program: WebGLProgram | undefined;
  let uniforms: Record<string, WebGLUniformLocation | null> = {};
  let loaded: Loaded | undefined;
  let lost = false;

  function initialize() {
    const linked = allocated(gl.createProgram());
    try {
      for (const [kind, source] of [
        [gl.VERTEX_SHADER, SHAPE_VERTEX],
        [gl.FRAGMENT_SHADER, SHAPE_FRAGMENT],
      ] as const) {
        const shader = allocated(gl.createShader(kind));
        try {
          gl.shaderSource(shader, source);
          gl.compileShader(shader);
          if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
            throw new Error(
              `Layout shader: ${gl.getShaderInfoLog(shader) ?? "did not compile"}`,
            );
          gl.attachShader(linked, shader);
        } finally {
          gl.deleteShader(shader);
        }
      }
      gl.linkProgram(linked);
      if (!gl.getProgramParameter(linked, gl.LINK_STATUS))
        throw new Error(
          `Layout shader: ${gl.getProgramInfoLog(linked) ?? "did not link"}`,
        );
    } catch (error) {
      gl.deleteProgram(linked);
      throw error;
    }
    program = linked;
    uniforms = Object.fromEntries(
      [
        "orientation",
        "scale",
        "viewport",
        "layers",
        "fill",
        "frame",
        "pattern",
        "atlas",
        "lines",
      ].map((name) => [name, gl.getUniformLocation(linked, `u_${name}`)]),
    );
    gl.useProgram(program);
    gl.uniformMatrix2fv(
      uniforms.orientation!,
      false,
      Float32Array.from(
        Array.from({ length: 8 }, (_, code) => orientation(code)).flat(),
      ),
    );
    gl.uniform1i(uniforms.atlas!, 0);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
  }
  function unload() {
    if (!loaded) return;
    for (const mesh of [...loaded.cells, ...loaded.top]) {
      gl.deleteVertexArray(mesh.vao);
      gl.deleteBuffer(mesh.vertices);
      gl.deleteBuffer(mesh.fill);
      gl.deleteBuffer(mesh.frame);
    }
    for (const instances of [...loaded.instances, loaded.origin])
      gl.deleteBuffer(instances.buffer);
    gl.deleteTexture(loaded.atlas);
    loaded = undefined;
  }
  function instanceBuffer(): InstanceBuffer {
    return {
      buffer: allocated(gl.createBuffer()),
      data: new Float32Array(5),
      count: 0,
      capacity: 0,
    };
  }
  function meshBuffer(mesh: Geometry, instances: InstanceBuffer): MeshBuffer {
    const vao = allocated(gl.createVertexArray());
    const buffers: WebGLBuffer[] = [];
    const buffer = () => {
      const value = allocated(gl.createBuffer());
      buffers.push(value);
      return value;
    };
    try {
      gl.bindVertexArray(vao);
      const vertices = buffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 20, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 20, 16);
      gl.bindBuffer(gl.ARRAY_BUFFER, instances.buffer);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 20, 0);
      gl.vertexAttribDivisor(2, 1);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 20, 16);
      gl.vertexAttribDivisor(3, 1);
      const fill = buffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, fill);
      gl.bufferData(
        gl.ELEMENT_ARRAY_BUFFER,
        mesh.fill.byteLength,
        gl.STATIC_DRAW,
      );
      const frame = buffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, frame);
      gl.bufferData(
        gl.ELEMENT_ARRAY_BUFFER,
        mesh.frame.byteLength,
        gl.STATIC_DRAW,
      );
      return { vao, vertices, fill, frame, fillCount: 0, frameCount: 0 };
    } catch (error) {
      gl.deleteVertexArray(vao);
      for (const value of buffers) gl.deleteBuffer(value);
      throw error;
    }
  }
  function load(scene: MaskScene): Loaded {
    if (loaded?.scene === scene) return loaded;
    unload();
    if (scene.layers.length > MAX_LAYERS)
      throw new Error(
        `The layout has ${scene.layers.length} layers; the view draws at most ${MAX_LAYERS}`,
      );
    const origin = instanceBuffer();
    const atlas = gl.createTexture();
    if (!atlas) {
      gl.deleteBuffer(origin.buffer);
      throw new Error("Cannot allocate layout pattern texture");
    }
    const data: Loaded = {
      scene,
      cells: [],
      top: [],
      instances: [],
      origin,
      atlas,
      visibility: "",
    };
    loaded = data;
    try {
      for (const cell of scene.cells) {
        const instances = instanceBuffer();
        data.instances.push(instances);
        data.cells.push(meshBuffer(cell, instances));
      }
      for (const top of scene.top) data.top.push(meshBuffer(top, data.origin));
      gl.bindVertexArray(null);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, data.atlas);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R8,
        PATTERN_SIZE,
        PATTERN_SIZE * Math.max(1, scene.layers.length),
        0,
        gl.RED,
        gl.UNSIGNED_BYTE,
        scene.layers.length ? patternAtlas(scene.layers) : null,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      const fills = new Float32Array(MAX_LAYERS * 4);
      const frames = new Float32Array(MAX_LAYERS * 4);
      const patterns = new Int32Array(MAX_LAYERS * 4);
      scene.layers.forEach((layer, index) => {
        fills.set(rgb(layer.fill), index * 4);
        frames.set(rgb(layer.frame), index * 4);
        patterns.set([...patternSize(layer), layer.offset, 0], index * 4);
      });
      gl.uniform4fv(uniforms.fill!, fills);
      gl.uniform4fv(uniforms.frame!, frames);
      gl.uniform4iv(uniforms.pattern!, patterns);
      gl.uniform1f(uniforms.layers!, scene.layers.length);
    } catch (error) {
      unload();
      throw error;
    }
    return data;
  }
  function append(
    instances: InstanceBuffer,
    x: number,
    y: number,
    code: number,
  ) {
    const offset = instances.count++ * 5;
    if (offset + 5 > instances.data.length) {
      const larger = new Float32Array(
        Math.max(offset + 5, instances.data.length * 2),
      );
      larger.set(instances.data);
      instances.data = larger;
    }
    const [xh, xl] = splitCoordinate(x),
      [yh, yl] = splitCoordinate(y);
    instances.data.set([xh, yh, xl, yl, code], offset);
  }
  function upload(instances: InstanceBuffer) {
    if (!instances.count) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, instances.buffer);
    if (instances.capacity < instances.data.byteLength) {
      gl.bufferData(
        gl.ARRAY_BUFFER,
        instances.data.byteLength,
        gl.DYNAMIC_DRAW,
      );
      instances.capacity = instances.data.byteLength;
    }
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      0,
      instances.data.subarray(0, instances.count * 5),
    );
  }
  function lostContext(event: Event) {
    event.preventDefault();
    lost = true;
    // WebGL invalidates all these handles; the CPU scene is retained by the owner.
    loaded = undefined;
    program = undefined;
    uniforms = {};
    onContextChange(true);
  }
  function restoredContext() {
    lost = false;
    onContextChange(false);
  }
  canvas.addEventListener("webglcontextlost", lostContext);
  canvas.addEventListener("webglcontextrestored", restoredContext);

  return {
    draw(scene, camera, viewport, hidden) {
      if (lost) return;
      if (!program) initialize();
      gl.useProgram(program!);
      const data = load(scene);
      if (canvas.width !== viewport.pixelWidth)
        canvas.width = viewport.pixelWidth;
      if (canvas.height !== viewport.pixelHeight)
        canvas.height = viewport.pixelHeight;
      gl.viewport(0, 0, viewport.pixelWidth, viewport.pixelHeight);
      gl.clearColor(14 / 255, 23 / 255, 32 / 255, 1);
      gl.clearDepth(1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.uniform1f(uniforms.scale!, camera.scale / scene.dbu);
      gl.uniform2f(uniforms.viewport!, viewport.width, viewport.height);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, data.atlas);
      const shown = scene.layers.map((layer) => !hidden.has(layer.source));
      const visibility = shown.map(Number).join("");
      if (visibility !== data.visibility) {
        for (const [meshes, buffers] of [
          [scene.cells, data.cells],
          [scene.top, data.top],
        ] as const) {
          meshes.forEach((mesh, i) => {
            const target = buffers[i]!;
            gl.bindVertexArray(target.vao);
            const fill = visibleIndices(mesh, shown, false),
              frame = visibleIndices(mesh, shown, true);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, target.fill);
            gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, fill);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, target.frame);
            gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, frame);
            target.fillCount = fill.length;
            target.frameCount = frame.length;
          });
        }
        data.visibility = visibility;
      }
      const seen = expandedBox(
        visibleBox(camera, viewport.width, viewport.height),
        1 / camera.scale,
      ).map((value) => value * scene.dbu) as [number, number, number, number];
      const cx = camera.x * scene.dbu,
        cy = camera.y * scene.dbu;
      for (const instances of data.instances) instances.count = 0;
      for (const i of querySpatial(scene.placements, seen)) {
        const offset = i * 4;
        const cell = scene.instances[offset]!;
        const mesh = data.cells[cell]!;
        if (!mesh.fillCount && !mesh.frameCount) continue;
        append(
          data.instances[cell]!,
          scene.instances[offset + 1]! - cx,
          scene.instances[offset + 2]! - cy,
          scene.instances[offset + 3]!,
        );
      }
      for (const instances of data.instances) upload(instances);
      data.origin.count = 0;
      append(data.origin, -cx, -cy, 0);
      upload(data.origin);
      const top = querySpatial(scene.routing, seen);
      for (const lines of [false, true]) {
        gl.uniform1i(uniforms.lines!, Number(lines));
        const draw = (mesh: MeshBuffer, count: number) => {
          const indices = lines ? mesh.frameCount : mesh.fillCount;
          if (!count || !indices) return;
          gl.bindVertexArray(mesh.vao);
          gl.bindBuffer(
            gl.ELEMENT_ARRAY_BUFFER,
            lines ? mesh.frame : mesh.fill,
          );
          gl.drawElementsInstanced(
            lines ? gl.LINES : gl.TRIANGLES,
            indices,
            gl.UNSIGNED_INT,
            0,
            count,
          );
        };
        data.cells.forEach((mesh, i) => draw(mesh, data.instances[i]!.count));
        for (const i of top) draw(data.top[i]!, 1);
      }
      gl.bindVertexArray(null);
    },
    dispose() {
      canvas.removeEventListener("webglcontextlost", lostContext);
      canvas.removeEventListener("webglcontextrestored", restoredContext);
      unload();
      if (program) gl.deleteProgram(program);
      program = undefined;
    },
  };
}
