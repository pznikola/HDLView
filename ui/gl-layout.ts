import earcut from "earcut";
import { type Camera, overlaps, visibleBox } from "./floorplan";
import { orientation, placedBox } from "./masks";
import type { MaskData, MaskLayer, MaskShapes } from "./types";

/** Placed cells narrower than this on screen are drawn as one box. */
export const DETAIL_PIXELS = 3;
/** The fragment shader's uniform arrays hold this many layers. */
export const MAX_LAYERS = 64;
/** Each layer's pattern bitmap is kept in a square of this many texels. */
const PATTERN_SIZE = 32;

/** Vertices of a cell: x, y in database units and the layer index, per vertex. */
export interface Geometry {
  /** Triangles. */
  fill: Float32Array;
  /** Line segments along every edge. */
  frame: Float32Array;
}
/**
 * Boxes and polygons per layer index as triangles and edges, moved by `dx, dy`.
 * Coordinates stay exact in single precision while they are below 2^24.
 */
export function geometry(
  layers: Iterable<[number, MaskShapes]>,
  dx = 0,
  dy = 0,
): Geometry {
  const fill: number[] = [];
  const frame: number[] = [];
  const edge = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    layer: number,
  ) => frame.push(x0 + dx, y0 + dy, layer, x1 + dx, y1 + dy, layer);
  for (const [layer, shapes] of layers) {
    const { boxes, polygons } = shapes;
    for (let at = 0; at + 3 < boxes.length; at += 4) {
      const [x0, y0, x1, y1] = [
        boxes[at]! + dx,
        boxes[at + 1]! + dy,
        boxes[at + 2]! + dx,
        boxes[at + 3]! + dy,
      ];
      fill.push(x0, y0, layer, x1, y0, layer, x1, y1, layer);
      fill.push(x0, y0, layer, x1, y1, layer, x0, y1, layer);
      edge(x0 - dx, y0 - dy, x1 - dx, y0 - dy, layer);
      edge(x1 - dx, y0 - dy, x1 - dx, y1 - dy, layer);
      edge(x1 - dx, y1 - dy, x0 - dx, y1 - dy, layer);
      edge(x0 - dx, y1 - dy, x0 - dx, y0 - dy, layer);
    }
    for (const points of polygons) {
      for (const index of earcut(points))
        fill.push(points[2 * index]! + dx, points[2 * index + 1]! + dy, layer);
      const count = points.length / 2;
      for (let i = 0; i < count; i++) {
        const next = (i + 1) % count;
        edge(
          points[2 * i]!,
          points[2 * i + 1]!,
          points[2 * next]!,
          points[2 * next + 1]!,
          layer,
        );
      }
    }
  }
  return { fill: Float32Array.from(fill), frame: Float32Array.from(frame) };
}

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

/** What to draw of the placements for one view, relative to the anchor. */
export interface Placements {
  /** cell index → x, y, orientation code per placement drawn in full */
  detailed: Map<number, Float32Array>;
  /** x0, y0, x1, y1 per placement drawn as one box */
  boxes: Float32Array;
}
/** The anchor every GPU coordinate is relative to: the centre of the layout. */
export function anchor(masks: MaskData): [number, number] {
  return [
    Math.round((masks.box[0] + masks.box[2]) / 2),
    Math.round((masks.box[1] + masks.box[3]) / 2),
  ];
}
export function placements(
  masks: MaskData,
  camera: Camera,
  size: { width: number; height: number },
): Placements {
  const [ax, ay] = anchor(masks);
  const unit = camera.scale / masks.dbu;
  const seen = visibleBox(camera, size.width, size.height).map(
    (value) => value * masks.dbu,
  ) as [number, number, number, number];
  const detailed = new Map<number, number[]>();
  const boxes: number[] = [];
  for (const [index, x, y, code] of masks.instances) {
    const cell = masks.cells[index];
    if (!cell) continue;
    const box = placedBox(cell.box, code, x, y);
    if (!overlaps(box, seen)) continue;
    if ((box[2] - box[0]) * unit < DETAIL_PIXELS)
      boxes.push(box[0] - ax, box[1] - ay, box[2] - ax, box[3] - ay);
    else {
      let list = detailed.get(index);
      if (!list) detailed.set(index, (list = []));
      list.push(x - ax, y - ay, code);
    }
  }
  return {
    detailed: new Map(
      [...detailed].map(([index, list]) => [index, Float32Array.from(list)]),
    ),
    boxes: Float32Array.from(boxes),
  };
}

const SHAPE_VERTEX = `#version 300 es
in vec2 a_position;
in float a_layer;
in vec3 a_place;
uniform mat2 u_orientation[8];
uniform vec2 u_camera;
uniform float u_scale;
uniform vec2 u_viewport;
uniform float u_layers;
flat out int v_layer;
void main() {
  vec2 p = u_orientation[int(a_place.z)] * a_position + a_place.xy;
  vec2 px = (p - u_camera) * u_scale;
  gl_Position = vec4(px.x / u_viewport.x * 2.0 - 1.0, px.y / u_viewport.y * 2.0 + 1.0,
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
  if (u_fill[v_layer].a < 0.5) discard;
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
const BOX_VERTEX = `#version 300 es
in vec2 a_corner;
in vec4 a_box;
uniform vec2 u_camera;
uniform float u_scale;
uniform vec2 u_viewport;
void main() {
  vec2 p = mix(a_box.xy, a_box.zw, a_corner);
  vec2 px = (p - u_camera) * u_scale;
  gl_Position = vec4(px.x / u_viewport.x * 2.0 - 1.0, px.y / u_viewport.y * 2.0 + 1.0, 1.0, 1.0);
}`;
const BOX_FRAGMENT = `#version 300 es
precision highp float;
uniform vec4 u_colour;
out vec4 colour;
void main() { colour = u_colour; }`;

function rgb(hex: string): [number, number, number] {
  const value = parseInt(hex.replace("#", ""), 16);
  return [
    ((value >> 16) & 255) / 255,
    ((value >> 8) & 255) / 255,
    (value & 255) / 255,
  ];
}

interface CellBuffers {
  fill: WebGLBuffer;
  fillCount: number;
  frame: WebGLBuffer;
  frameCount: number;
}
interface Loaded {
  masks: MaskData;
  top: CellBuffers;
  cells: CellBuffers[];
  atlas: WebGLTexture;
  fills: Float32Array;
  frames: Float32Array;
  patterns: Int32Array;
}

/** Draws the masks of a layout on a WebGL2 canvas. */
export interface LayoutRenderer {
  draw(
    masks: MaskData,
    camera: Camera,
    size: { width: number; height: number },
    ratio: number,
    hidden: Set<string>,
    placed: Placements,
  ): void;
  dispose(): void;
}
/** `undefined` when the browser cannot give a WebGL2 context. */
export function createRenderer(
  canvas: HTMLCanvasElement,
): LayoutRenderer | undefined {
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
  if (!gl) return undefined;
  const program = (vertex: string, fragment: string) => {
    const linked = gl.createProgram();
    for (const [kind, source] of [
      [gl.VERTEX_SHADER, vertex],
      [gl.FRAGMENT_SHADER, fragment],
    ] as const) {
      const shader = gl.createShader(kind)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(
          `Layout shader: ${gl.getShaderInfoLog(shader) ?? "did not compile"}`,
        );
      gl.attachShader(linked, shader);
    }
    gl.linkProgram(linked);
    if (!gl.getProgramParameter(linked, gl.LINK_STATUS))
      throw new Error(
        `Layout shader: ${gl.getProgramInfoLog(linked) ?? "did not link"}`,
      );
    return linked;
  };
  const shapes = program(SHAPE_VERTEX, SHAPE_FRAGMENT);
  const boxes = program(BOX_VERTEX, BOX_FRAGMENT);
  const location = (p: WebGLProgram, name: string) =>
    gl.getUniformLocation(p, name);
  const attribute = (p: WebGLProgram, name: string) =>
    gl.getAttribLocation(p, name);
  const shapeAttributes = {
    position: attribute(shapes, "a_position"),
    layer: attribute(shapes, "a_layer"),
    place: attribute(shapes, "a_place"),
  };
  const boxAttributes = {
    corner: attribute(boxes, "a_corner"),
    box: attribute(boxes, "a_box"),
  };
  const instances = gl.createBuffer();
  const one = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, one);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 0]), gl.STATIC_DRAW);
  const corners = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, corners);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]),
    gl.STATIC_DRAW,
  );
  gl.useProgram(shapes);
  gl.uniformMatrix2fv(
    location(shapes, "u_orientation"),
    false,
    Float32Array.from(
      Array.from({ length: 8 }, (_, code) => orientation(code)).flat(),
    ),
  );
  gl.uniform1i(location(shapes, "u_atlas"), 0);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);

  let loaded: Loaded | undefined;
  const upload = (data: Float32Array) => {
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return buffer;
  };
  const buffers = (g: Geometry): CellBuffers => ({
    fill: upload(g.fill),
    fillCount: g.fill.length / 3,
    frame: upload(g.frame),
    frameCount: g.frame.length / 3,
  });
  const unload = () => {
    if (!loaded) return;
    for (const cell of [loaded.top, ...loaded.cells]) {
      gl.deleteBuffer(cell.fill);
      gl.deleteBuffer(cell.frame);
    }
    gl.deleteTexture(loaded.atlas);
    loaded = undefined;
  };
  const load = (masks: MaskData): Loaded => {
    if (loaded?.masks === masks) return loaded;
    unload();
    if (masks.layers.length > MAX_LAYERS)
      throw new Error(
        `The layout has ${masks.layers.length} layers; the view draws at most ${MAX_LAYERS}`,
      );
    const [ax, ay] = anchor(masks);
    const atlas = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, atlas);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8,
      PATTERN_SIZE,
      PATTERN_SIZE * Math.max(1, masks.layers.length),
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      masks.layers.length ? patternAtlas(masks.layers) : null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const fills = new Float32Array(MAX_LAYERS * 4);
    const frames = new Float32Array(MAX_LAYERS * 4);
    const patterns = new Int32Array(MAX_LAYERS * 4);
    masks.layers.forEach((layer, index) => {
      fills.set(rgb(layer.fill), index * 4);
      frames.set(rgb(layer.frame), index * 4);
      patterns.set([...patternSize(layer), layer.offset, 0], index * 4);
    });
    loaded = {
      masks,
      top: buffers(
        geometry(
          masks.shapes.map((shapes, layer): [number, MaskShapes] => [
            layer,
            shapes,
          ]),
          -ax,
          -ay,
        ),
      ),
      cells: masks.cells.map((cell) =>
        buffers(
          geometry(
            Object.entries(cell.layers).map(([layer, shapes]) => [
              Number(layer),
              shapes,
            ]),
          ),
        ),
      ),
      atlas,
      fills,
      frames,
      patterns,
    };
    return loaded;
  };
  const pointer = (
    index: number,
    buffer: WebGLBuffer,
    size: number,
    stride: number,
    offset: number,
    divisor: number,
  ) => {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(index);
    gl.vertexAttribPointer(
      index,
      size,
      gl.FLOAT,
      false,
      stride * 4,
      offset * 4,
    );
    gl.vertexAttribDivisor(index, divisor);
  };

  return {
    draw(masks, camera, size, ratio, hidden, placed) {
      const data = load(masks);
      const width = Math.max(1, Math.round(size.width * ratio));
      const height = Math.max(1, Math.round(size.height * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      gl.viewport(0, 0, width, height);
      gl.clearColor(14 / 255, 23 / 255, 32 / 255, 1);
      gl.clearDepth(1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      const [ax, ay] = anchor(masks);
      const view = {
        camera: [camera.x * masks.dbu - ax, camera.y * masks.dbu - ay],
        scale: (camera.scale / masks.dbu) * ratio,
      };
      // The layout's extent, then the placements too small to draw in full.
      gl.useProgram(boxes);
      gl.uniform2fv(location(boxes, "u_camera"), view.camera);
      gl.uniform1f(location(boxes, "u_scale"), view.scale);
      gl.uniform2f(location(boxes, "u_viewport"), width, height);
      pointer(boxAttributes.corner, corners, 2, 2, 0, 0);
      for (const [colour, list] of [
        [
          [20 / 255, 31 / 255, 42 / 255],
          Float32Array.from([
            masks.box[0] - ax,
            masks.box[1] - ay,
            masks.box[2] - ax,
            masks.box[3] - ay,
          ]),
        ],
        [[34 / 255, 50 / 255, 63 / 255], placed.boxes],
      ] as const) {
        if (!list.length) continue;
        gl.uniform4f(location(boxes, "u_colour"), ...colour, 1);
        gl.bindBuffer(gl.ARRAY_BUFFER, instances);
        gl.bufferData(gl.ARRAY_BUFFER, list, gl.DYNAMIC_DRAW);
        pointer(boxAttributes.box, instances, 4, 4, 0, 1);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, list.length / 4);
      }
      gl.useProgram(shapes);
      gl.uniform2fv(location(shapes, "u_camera"), view.camera);
      gl.uniform1f(location(shapes, "u_scale"), view.scale);
      gl.uniform2f(location(shapes, "u_viewport"), width, height);
      gl.uniform1f(location(shapes, "u_layers"), masks.layers.length);
      const fills = Float32Array.from(data.fills);
      masks.layers.forEach((layer, index) => {
        fills[index * 4 + 3] = hidden.has(layer.source) ? 0 : 1;
      });
      gl.uniform4fv(location(shapes, "u_fill"), fills);
      gl.uniform4fv(location(shapes, "u_frame"), data.frames);
      gl.uniform4iv(location(shapes, "u_pattern"), data.patterns);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, data.atlas);
      // Fills of every placed cell and of the top cell, then their frames on top.
      for (const lines of [false, true]) {
        gl.uniform1i(location(shapes, "u_lines"), lines ? 1 : 0);
        const mode = lines ? gl.LINES : gl.TRIANGLES;
        const stamp = (cell: CellBuffers, count: number) => {
          const buffer = lines ? cell.frame : cell.fill;
          const vertices = lines ? cell.frameCount : cell.fillCount;
          if (!vertices) return;
          pointer(shapeAttributes.position, buffer, 2, 3, 0, 0);
          pointer(shapeAttributes.layer, buffer, 1, 3, 2, 0);
          gl.drawArraysInstanced(mode, 0, vertices, count);
        };
        for (const [index, list] of placed.detailed) {
          const cell = data.cells[index];
          if (!cell) continue;
          gl.bindBuffer(gl.ARRAY_BUFFER, instances);
          gl.bufferData(gl.ARRAY_BUFFER, list, gl.DYNAMIC_DRAW);
          pointer(shapeAttributes.place, instances, 3, 3, 0, 1);
          stamp(cell, list.length / 3);
        }
        pointer(shapeAttributes.place, one, 3, 3, 0, 1);
        stamp(data.top, 1);
      }
    },
    dispose() {
      unload();
      gl.deleteBuffer(instances);
      gl.deleteBuffer(one);
      gl.deleteBuffer(corners);
      gl.deleteProgram(shapes);
      gl.deleteProgram(boxes);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
