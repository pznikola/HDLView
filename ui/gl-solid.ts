import { type Box } from "./floorplan";
import { type Viewport } from "./gl-layout";
import { orientation } from "./masks";
import { querySpatial } from "./mask-scene";
import {
  extrude,
  VERTEX_BYTES,
  type SolidGeometry,
  type SolidScene,
} from "./solid-scene";

export const MAX_SLABS = 64;
/**
 * A placed cell whose tallest wall would cover fewer pixels than this is drawn
 * as its top faces only. Wires keep their walls at every distance: a wire is
 * as tall as it is wide, so its walls are much of what is seen of it.
 */
const FAR_PIXELS = 2;
/** Vertical field of view in degrees. */
export const FOV = 45;

/** An orbit around a pivot: angles in degrees, lengths in µm, z before the z scale. */
export interface SolidCamera {
  pivot: [number, number, number];
  /** Turn around the vertical axis; 0 looks north. */
  azimuth: number;
  /** Angle above the ground plane; 90 is the top view. */
  elevation: number;
  distance: number;
  /** Heights are stretched by this factor so thin layers stay visible. */
  zScale: number;
}

type Vec3 = [number, number, number];
const radians = (degrees: number) => (degrees * Math.PI) / 180;
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const scaled = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const sum = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const normalised = (a: Vec3): Vec3 => scaled(a, 1 / (Math.hypot(...a) || 1));

/** Unit forward, right and up vectors in world space with the z scale applied. */
export function basis(camera: SolidCamera): {
  forward: Vec3;
  right: Vec3;
  up: Vec3;
} {
  const az = radians(camera.azimuth),
    el = radians(camera.elevation);
  const forward: Vec3 = [
    -Math.sin(az) * Math.cos(el),
    Math.cos(az) * Math.cos(el),
    -Math.sin(el),
  ];
  const up: Vec3 = [
    -Math.sin(az) * Math.sin(el),
    Math.cos(az) * Math.sin(el),
    Math.cos(el),
  ];
  return { forward, right: cross(forward, up), up };
}
/** Pivot and eye in µm with the z scale applied. */
function placed(camera: SolidCamera): { pivot: Vec3; eye: Vec3 } {
  const pivot: Vec3 = [
    camera.pivot[0],
    camera.pivot[1],
    camera.pivot[2] * camera.zScale,
  ];
  return {
    pivot,
    eye: sum(pivot, scaled(basis(camera).forward, -camera.distance)),
  };
}

/** A view from the south-west showing the whole box, in µm. */
export function fitSolid(
  box: Box,
  zRange: [number, number],
  aspect: number,
  zScale = 1,
): SolidCamera {
  const radius =
    Math.hypot(
      box[2] - box[0],
      box[3] - box[1],
      (zRange[1] - zRange[0]) * zScale,
    ) / 2;
  const half = radians(FOV / 2);
  const narrow = Math.min(half, Math.atan(Math.tan(half) * aspect));
  return {
    pivot: [
      (box[0] + box[2]) / 2,
      (box[1] + box[3]) / 2,
      (zRange[0] + zRange[1]) / 2,
    ],
    azimuth: 25,
    elevation: 35,
    distance: (Math.max(radius, 1e-3) / Math.sin(narrow)) * 1.1,
    zScale,
  };
}
export function topView(camera: SolidCamera): SolidCamera {
  return { ...camera, azimuth: 0, elevation: 90 };
}
export function orbit(
  camera: SolidCamera,
  dx: number,
  dy: number,
): SolidCamera {
  return {
    ...camera,
    azimuth: (((camera.azimuth - dx * 0.4) % 360) + 360) % 360,
    elevation: Math.min(90, Math.max(-90, camera.elevation + dy * 0.4)),
  };
}
/** Move the pivot in the view plane by a pointer motion in pixels. */
export function pan(
  camera: SolidCamera,
  dx: number,
  dy: number,
  viewport: Viewport,
): SolidCamera {
  const perPixel =
    (2 * camera.distance * Math.tan(radians(FOV / 2))) / viewport.height;
  const { right, up } = basis(camera);
  const move = sum(scaled(right, -dx * perPixel), scaled(up, dy * perPixel));
  return {
    ...camera,
    pivot: [
      camera.pivot[0] + move[0],
      camera.pivot[1] + move[1],
      camera.pivot[2] + move[2] / camera.zScale,
    ],
  };
}
export function dolly(camera: SolidCamera, factor: number): SolidCamera {
  return {
    ...camera,
    distance: Math.min(1e7, Math.max(0.01, camera.distance * factor)),
  };
}

/** The far clipping distance in µm, beyond the whole box seen from its inside. */
function farDistance(
  camera: SolidCamera,
  box: Box,
  zRange: [number, number],
): number {
  const diagonal = Math.hypot(
    box[2] - box[0],
    box[3] - box[1],
    (zRange[1] - zRange[0]) * camera.zScale,
  );
  return (camera.distance + diagonal) * 1.1;
}

type Mat4 = Float64Array;
function perspective(aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(radians(FOV / 2));
  const m = new Float64Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}
function lookAt(eye: Vec3, forward: Vec3, up: Vec3): Mat4 {
  const f = normalised(forward);
  const r = normalised(cross(f, up));
  const u = cross(r, f);
  const m = new Float64Array(16);
  [m[0], m[4], m[8]] = r;
  [m[1], m[5], m[9]] = u;
  [m[2], m[6], m[10]] = [-f[0], -f[1], -f[2]];
  m[12] = -dot(r, eye);
  m[13] = -dot(u, eye);
  m[14] = dot(f, eye);
  m[15] = 1;
  return m;
}
function multiply(a: Mat4, b: Mat4): Mat4 {
  const m = new Float64Array(16);
  for (let column = 0; column < 4; column++)
    for (let row = 0; row < 4; row++) {
      let value = 0;
      for (let k = 0; k < 4; k++) value += a[k * 4 + row]! * b[column * 4 + k]!;
      m[column * 4 + row] = value;
    }
  return m;
}

/** The scene's reference point in whole database units; the GPU works relative to it. */
export function sceneAnchor(scene: SolidScene): [number, number] {
  return [
    Math.floor((scene.box[0] + scene.box[2]) / 2),
    Math.floor((scene.box[1] + scene.box[3]) / 2),
  ];
}
/**
 * Projection × view in database units relative to the anchor, with the near
 * and far planes chosen for this scene so depth keeps its precision.
 */
export function matrices(
  camera: SolidCamera,
  viewport: Viewport,
  scene: SolidScene,
): { matrix: Mat4; light: Vec3; eye: Vec3 } {
  const { forward, right, up } = basis(camera);
  const { eye } = placed(camera);
  const [ax, ay] = sceneAnchor(scene);
  const anchored: Vec3 = [
    (eye[0] - ax / scene.dbu) * scene.dbu,
    (eye[1] - ay / scene.dbu) * scene.dbu,
    eye[2] * scene.dbu,
  ];
  const far =
    farDistance(
      camera,
      scene.box.map((v) => v / scene.dbu) as Box,
      scene.zRange,
    ) * scene.dbu;
  const near = Math.max(far * 1e-5, camera.distance * 0.02 * scene.dbu);
  return {
    matrix: multiply(
      perspective(viewport.width / viewport.height, near, far),
      lookAt(anchored, forward, up),
    ),
    // Light from over the viewer's left shoulder, so walls and caps differ.
    light: normalised(
      sum(sum(scaled(right, -0.3), scaled(up, 0.5)), scaled(forward, -0.8)),
    ),
    eye: anchored,
  };
}
/** Where a point (µm, z unscaled) lands in normalised device coordinates. */
export function project(
  camera: SolidCamera,
  viewport: Viewport,
  scene: SolidScene,
  point: Vec3,
): [number, number] {
  const { matrix } = matrices(camera, viewport, scene);
  const [ax, ay] = sceneAnchor(scene);
  const v = [
    point[0] * scene.dbu - ax,
    point[1] * scene.dbu - ay,
    point[2] * camera.zScale * scene.dbu,
    1,
  ];
  const out = [0, 0, 0, 0];
  for (let row = 0; row < 4; row++)
    for (let k = 0; k < 4; k++) out[row]! += matrix[k * 4 + row]! * v[k]!;
  return [out[0]! / out[3]!, out[1]! / out[3]!];
}
/**
 * The ground area the view can show, in µm: the box around the part of the
 * view's pyramid, cut at the far distance, that lies between the stack's
 * lowest and highest planes. Inverted when the view misses the stack.
 */
export function footprint(
  camera: SolidCamera,
  viewport: Viewport,
  box: Box,
  zRange: [number, number],
): Box {
  const { forward, right, up } = basis(camera);
  const { eye } = placed(camera);
  const tangent = Math.tan(radians(FOV / 2));
  const aspect = viewport.width / viewport.height;
  const far = farDistance(camera, box, zRange);
  const corners = (
    [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const
  ).map(([sx, sy]) =>
    sum(
      eye,
      scaled(
        sum(
          forward,
          sum(scaled(right, sx * tangent * aspect), scaled(up, sy * tangent)),
        ),
        far,
      ),
    ),
  );
  const low = zRange[0] * camera.zScale,
    high = zRange[1] * camera.zScale;
  const area: Box = [Infinity, Infinity, -Infinity, -Infinity];
  const include = (x: number, y: number) => {
    area[0] = Math.min(area[0], x);
    area[1] = Math.min(area[1], y);
    area[2] = Math.max(area[2], x);
    area[3] = Math.max(area[3], y);
  };
  // The part between the planes is spanned by the pyramid's corners there
  // and by the points where its edges cross a plane.
  const edge = (a: Vec3, b: Vec3) => {
    if (a[2] >= low && a[2] <= high) include(a[0], a[1]);
    for (const z of [low, high]) {
      const t = (z - a[2]) / (b[2] - a[2]);
      if (t > 0 && t < 1)
        include(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
    }
  };
  corners.forEach((corner, i) => {
    edge(eye, corner);
    edge(corner, corners[(i + 1) % 4]!);
  });
  return [
    Math.max(area[0], box[0]),
    Math.max(area[1], box[1]),
    Math.min(area[2], box[2]),
    Math.min(area[3], box[3]),
  ];
}

const SOLID_VERTEX = `#version 300 es
layout(location=0) in vec3 a_position;
layout(location=1) in vec3 a_normal;
layout(location=2) in float a_slab;
layout(location=3) in vec2 a_place;
layout(location=4) in float a_code;
uniform mat2 u_orientation[8];
uniform mat4 u_matrix;
uniform float u_zScale;
out vec3 v_normal;
flat out int v_slab;
void main() {
  mat2 orientation = u_orientation[int(a_code)];
  vec3 world = vec3(orientation * a_position.xy + a_place, a_position.z * u_zScale);
  gl_Position = u_matrix * vec4(world, 1.0);
  v_normal = vec3(orientation * a_normal.xy, a_normal.z);
  v_slab = int(a_slab);
}`;
const SOLID_FRAGMENT = `#version 300 es
precision highp float;
in vec3 v_normal;
flat in int v_slab;
uniform vec4 u_fill[${MAX_SLABS}];
uniform vec3 u_light;
uniform vec4 u_override;
out vec4 colour;
void main() {
  vec3 n = normalize(v_normal);
  float shade = min(1.0, 0.35 + 0.65 * abs(dot(n, u_light)) + 0.1 * max(n.z, 0.0));
  vec3 base = u_override.a > 0.0 ? u_override.rgb : u_fill[v_slab].rgb;
  colour = vec4(base * shade, 1.0);
}`;

function rgb(hex: string): [number, number, number] {
  const value = parseInt(hex.replace("#", ""), 16);
  return [
    ((value >> 16) & 255) / 255,
    ((value >> 8) & 255) / 255,
    (value & 255) / 255,
  ];
}

/** Bytes per instance: x, y and the orientation code as float32. */
const INSTANCE_BYTES = 12;
interface MeshBuffer {
  vao: WebGLVertexArrayObject;
  vertices: WebGLBuffer;
  indices: WebGLBuffer;
  instances: WebGLBuffer;
  /** Indices of the visible slabs: their top faces, then everything else. */
  count: number;
  /** How many of them are the top faces. */
  caps: number;
  /** The height of the tallest visible slab in µm. */
  thickness: number;
  /** Bytes allocated for the instances. */
  capacity: number;
}
interface InstanceData {
  data: Float32Array;
  count: number;
}
interface Loaded {
  scene: SolidScene;
  cells: MeshBuffer[];
  /**
   * Per cell, its placements in view, near ones then far ones: of each, those
   * that keep the cell's handedness, then the mirrored ones, which turn every
   * triangle the other way round.
   */
  placements: InstanceData[][];
  /** What the placements were last chosen for. */
  grouped?: { seen: Box; eye: Vec3; reach: number };
  top: MeshBuffer[];
  outline: MeshBuffer;
  highlight?: { geometry: SolidGeometry; mesh: MeshBuffer };
  visibility: string;
}
export interface SolidRenderer {
  /**
   * `highlight` is drawn white over the scene; it is relative to the scene's
   * anchor, as `highlightGeometry` builds it.
   */
  draw(
    scene: SolidScene,
    camera: SolidCamera,
    viewport: Viewport,
    hidden: ReadonlySet<string>,
    highlight?: SolidGeometry,
  ): void;
  dispose(): void;
}

/**
 * Boxes (database units) on slabs, and a lid over the whole stack, extruded
 * relative to the scene's anchor.
 */
export function highlightGeometry(
  scene: SolidScene,
  boxes: Map<number, number[]>,
  lid?: number[],
): SolidGeometry {
  const top = scene.zRange[1];
  const thickness = Math.max(1e-3, (top - scene.zRange[0]) * 0.03);
  const parts: [number, { boxes: number[]; polygons: [] }][] = [...boxes].map(
    ([slab, flat]) => [slab, { boxes: flat, polygons: [] }],
  );
  if (lid) parts.push([scene.slabs.length, { boxes: lid, polygons: [] }]);
  return extrude(
    parts,
    extraSlab(scene, top, top + thickness),
    scene.dbu,
    sceneAnchor(scene),
  );
}
/** The scene's slabs plus one for geometry at another height. */
function extraSlab(
  scene: SolidScene,
  zstart: number,
  zstop: number,
): SolidScene["slabs"] {
  return [...scene.slabs, { material: 0, zstart, zstop }];
}

function allocated<T>(value: T | null): T {
  if (value === null) throw new Error("Cannot allocate 3D view GPU resources");
  return value;
}

export function createSolidRenderer(
  canvas: HTMLCanvasElement,
  onContextChange: (lost: boolean) => void = () => {},
): SolidRenderer | undefined {
  const context = canvas.getContext("webgl2", {
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  if (!context) return undefined;
  const gl = context;
  let program: WebGLProgram | undefined;
  let uniforms: Record<string, WebGLUniformLocation | null> = {};
  let loaded: Loaded | undefined;
  let lost = false;
  const matrix32 = new Float32Array(16);

  function initialize() {
    const linked = allocated(gl.createProgram());
    try {
      for (const [kind, source] of [
        [gl.VERTEX_SHADER, SOLID_VERTEX],
        [gl.FRAGMENT_SHADER, SOLID_FRAGMENT],
      ] as const) {
        const shader = allocated(gl.createShader(kind));
        try {
          gl.shaderSource(shader, source);
          gl.compileShader(shader);
          if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
            throw new Error(
              `3D view shader: ${gl.getShaderInfoLog(shader) ?? "did not compile"}`,
            );
          gl.attachShader(linked, shader);
        } finally {
          gl.deleteShader(shader);
        }
      }
      gl.linkProgram(linked);
      if (!gl.getProgramParameter(linked, gl.LINK_STATUS))
        throw new Error(
          `3D view shader: ${gl.getProgramInfoLog(linked) ?? "did not link"}`,
        );
    } catch (error) {
      gl.deleteProgram(linked);
      throw error;
    }
    program = linked;
    uniforms = Object.fromEntries(
      ["orientation", "matrix", "zScale", "fill", "light", "override"].map(
        (name) => [name, gl.getUniformLocation(linked, `u_${name}`)],
      ),
    );
    gl.useProgram(program);
    gl.uniformMatrix2fv(
      uniforms.orientation!,
      false,
      Float32Array.from(
        Array.from({ length: 8 }, (_, code) => orientation(code)).flat(),
      ),
    );
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.enable(gl.CULL_FACE);
  }
  function deleteMesh(mesh: MeshBuffer) {
    gl.deleteVertexArray(mesh.vao);
    gl.deleteBuffer(mesh.vertices);
    gl.deleteBuffer(mesh.indices);
    gl.deleteBuffer(mesh.instances);
  }
  function unload() {
    if (!loaded) return;
    for (const mesh of [...loaded.cells, ...loaded.top, loaded.outline])
      deleteMesh(mesh);
    if (loaded.highlight) deleteMesh(loaded.highlight.mesh);
    loaded = undefined;
  }
  /** A mesh with its index buffer allocated at full size and an empty instance buffer. */
  function meshBuffer(mesh: SolidGeometry): MeshBuffer {
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
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, VERTEX_BYTES, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.BYTE, true, VERTEX_BYTES, 12);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 1, gl.UNSIGNED_BYTE, false, VERTEX_BYTES, 15);
      const instances = buffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, instances);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 2, gl.FLOAT, false, INSTANCE_BYTES, 0);
      gl.vertexAttribDivisor(3, 1);
      gl.enableVertexAttribArray(4);
      gl.vertexAttribPointer(4, 1, gl.FLOAT, false, INSTANCE_BYTES, 8);
      gl.vertexAttribDivisor(4, 1);
      const indices = buffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
      gl.bufferData(
        gl.ELEMENT_ARRAY_BUFFER,
        mesh.indices.byteLength,
        gl.STATIC_DRAW,
      );
      return {
        vao,
        vertices,
        indices,
        instances,
        count: 0,
        caps: 0,
        thickness: 0,
        capacity: 0,
      };
    } catch (error) {
      gl.deleteVertexArray(vao);
      for (const value of buffers) gl.deleteBuffer(value);
      throw error;
    }
  }
  /** One fixed instance at an offset from the anchor. */
  function staticInstance(mesh: MeshBuffer, x: number, y: number) {
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.instances);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      Float32Array.from([x, y, 0]),
      gl.STATIC_DRAW,
    );
  }
  /** Send the indices of the slabs to show, every one without `shown`. */
  function setIndices(
    mesh: MeshBuffer,
    geometry: SolidGeometry,
    slabs: SolidScene["slabs"],
    shown?: boolean[],
  ) {
    const ranges = geometry.ranges.filter(
      (range) => !shown || shown[range.layer],
    );
    const indices = new Uint32Array(ranges.reduce((n, r) => n + r.count, 0));
    let offset = 0;
    for (const caps of [true, false])
      for (const range of ranges) {
        const start = range.start + (caps ? 0 : range.caps);
        const count = caps ? range.caps : range.count - range.caps;
        indices.set(geometry.indices.subarray(start, start + count), offset);
        offset += count;
      }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indices);
    gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, indices);
    mesh.count = indices.length;
    mesh.caps = ranges.reduce((n, range) => n + range.caps, 0);
    mesh.thickness = ranges.reduce((most, range) => {
      const slab = slabs[range.layer];
      return slab ? Math.max(most, slab.zstop - slab.zstart) : most;
    }, 0);
  }
  function load(scene: SolidScene): Loaded {
    if (loaded?.scene === scene) return loaded;
    unload();
    if (scene.slabs.length > MAX_SLABS)
      throw new Error(
        `The stack has ${scene.slabs.length} slabs; the 3D view draws at most ${MAX_SLABS}`,
      );
    const [ax, ay] = sceneAnchor(scene);
    const [x0, y0, x1, y1] = scene.box;
    // The outline of the shown area: a thin frame on the ground.
    const margin = Math.max(1, Math.round((x1 - x0 + y1 - y0) / 400));
    const frame = extrude(
      [
        [
          scene.slabs.length,
          {
            boxes: [
              x0 - margin,
              y0 - margin,
              x1 + margin,
              y0,
              x0 - margin,
              y1,
              x1 + margin,
              y1 + margin,
              x0 - margin,
              y0,
              x0,
              y1,
              x1,
              y0,
              x1 + margin,
              y1,
            ],
            polygons: [],
          },
        ],
      ],
      extraSlab(scene, -0.02, 0),
      scene.dbu,
      [ax, ay],
    );
    const data: Loaded = {
      scene,
      cells: [],
      placements: [],
      top: [],
      outline: meshBuffer(frame),
      visibility: "",
    };
    loaded = data;
    try {
      setIndices(data.outline, frame, scene.slabs);
      staticInstance(data.outline, 0, 0);
      for (const cell of scene.cells) {
        data.cells.push(meshBuffer(cell));
        data.placements.push(
          Array.from({ length: 4 }, () => ({
            data: new Float32Array(3),
            count: 0,
          })),
        );
      }
      scene.top.forEach((batch, i) => {
        const mesh = meshBuffer(batch);
        data.top.push(mesh);
        staticInstance(
          mesh,
          scene.origins[i * 2]! - ax,
          scene.origins[i * 2 + 1]! - ay,
        );
      });
      gl.bindVertexArray(null);
      const fills = new Float32Array(MAX_SLABS * 4);
      scene.slabs.forEach((slab, index) => {
        const material = scene.materials[slab.material];
        if (!material) throw new Error(`Unknown material ${slab.material}`);
        fills.set(rgb(material.fill), index * 4);
      });
      gl.uniform4fv(uniforms.fill!, fills);
    } catch (error) {
      unload();
      throw error;
    }
    return data;
  }
  function append(instances: InstanceData, x: number, y: number, code: number) {
    const offset = instances.count++ * 3;
    if (offset + 3 > instances.data.length) {
      const larger = new Float32Array(instances.data.length * 2);
      larger.set(instances.data);
      instances.data = larger;
    }
    instances.data[offset] = x;
    instances.data[offset + 1] = y;
    instances.data[offset + 2] = code;
  }
  /** Draw a cell at its placements in view, sending them first when they changed. */
  function drawPlaced(
    mesh: MeshBuffer,
    groups: InstanceData[],
    changed: boolean,
  ) {
    const bytes =
      groups.reduce((n, group) => n + group.count, 0) * INSTANCE_BYTES;
    if (!bytes || !mesh.count) return;
    gl.bindVertexArray(mesh.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.instances);
    if (changed) {
      // A fresh store each time, so the upload never waits for a frame that
      // still reads the old one; every group is sent before any is drawn.
      mesh.capacity = Math.max(bytes, mesh.capacity);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.capacity, gl.DYNAMIC_DRAW);
      let offset = 0;
      for (const group of groups) {
        gl.bufferSubData(
          gl.ARRAY_BUFFER,
          offset,
          group.data.subarray(0, group.count * 3),
        );
        offset += group.count * INSTANCE_BYTES;
      }
    }
    let offset = 0;
    groups.forEach((group, k) => {
      if (!group.count) return;
      gl.vertexAttribPointer(3, 2, gl.FLOAT, false, INSTANCE_BYTES, offset);
      gl.vertexAttribPointer(4, 1, gl.FLOAT, false, INSTANCE_BYTES, offset + 8);
      gl.frontFace(k % 2 ? gl.CW : gl.CCW);
      gl.drawElementsInstanced(
        gl.TRIANGLES,
        k < 2 ? mesh.count : mesh.caps,
        gl.UNSIGNED_INT,
        0,
        group.count,
      );
      offset += group.count * INSTANCE_BYTES;
    });
    gl.frontFace(gl.CCW);
  }
  function drawMesh(mesh: MeshBuffer) {
    if (!mesh.count) return;
    gl.bindVertexArray(mesh.vao);
    gl.drawElementsInstanced(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0, 1);
  }
  function lostContext(event: Event) {
    event.preventDefault();
    lost = true;
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
    draw(scene, camera, viewport, hidden, highlight) {
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
      const { matrix, light, eye } = matrices(camera, viewport, scene);
      matrix32.set(matrix);
      gl.uniformMatrix4fv(uniforms.matrix!, false, matrix32);
      gl.uniform1f(uniforms.zScale!, camera.zScale);
      gl.uniform3fv(uniforms.light!, light);
      const shown = scene.slabs.map(
        (slab) => !hidden.has(scene.materials[slab.material]!.name),
      );
      const visibility = shown.map(Number).join("");
      if (visibility !== data.visibility) {
        for (const [meshes, buffers] of [
          [scene.cells, data.cells],
          [scene.top, data.top],
        ] as const)
          meshes.forEach((mesh, i) =>
            setIndices(buffers[i]!, mesh, scene.slabs, shown),
          );
        data.visibility = visibility;
        data.grouped = undefined;
      }
      if (data.highlight && data.highlight.geometry !== highlight) {
        deleteMesh(data.highlight.mesh);
        data.highlight = undefined;
      }
      if (highlight && !data.highlight) {
        const mesh = meshBuffer(highlight);
        setIndices(mesh, highlight, scene.slabs);
        staticInstance(mesh, 0, 0);
        gl.bindVertexArray(null);
        data.highlight = { geometry: highlight, mesh };
      }
      const [ax, ay] = sceneAnchor(scene);
      const seen = footprint(
        camera,
        viewport,
        scene.box.map((v) => v / scene.dbu) as Box,
        scene.zRange,
      ).map((v) => v * scene.dbu) as Box;
      // From above the stack only top faces and walls can be seen, and a
      // wall of height h at ground distance r and distance d covers about
      // h · r / d² of a radian, so walls are too small to see when
      // h · r · reach < d².
      const ceiling = scene.zRange[1] * camera.zScale * scene.dbu;
      const reach =
        eye[2] > ceiling
          ? (viewport.pixelHeight * camera.zScale * scene.dbu) /
            (2 * Math.tan(radians(FOV / 2)) * FAR_PIXELS)
          : 0;
      const height = eye[2] - ceiling;
      /** Whether the placement whose box starts here is far. */
      const far = (mesh: MeshBuffer, at: number) => {
        const boxes = scene.placements.items;
        const x0 = boxes[at]!,
          y0 = boxes[at + 1]!,
          x1 = boxes[at + 2]!,
          y1 = boxes[at + 3]!;
        const x = (x0 + x1) / 2 - ax - eye[0],
          y = (y0 + y1) / 2 - ay - eye[1];
        const square = x * x + y * y;
        return (
          mesh.thickness *
            (Math.sqrt(square) + (x1 - x0 + y1 - y0) / 2) *
            reach <
          square + height * height
        );
      };
      // The placements are kept while the same ground is in view and the
      // viewer has hardly moved: turning around a whole scene regroups them
      // every few frames only.
      const known = data.grouped;
      const changed =
        !known ||
        known.reach !== reach ||
        known.seen.some((value, i) => value !== seen[i]) ||
        (reach > 0 &&
          Math.hypot(...eye.map((value, i) => value - known.eye[i]!)) >
            camera.distance * scene.dbu * 0.03);
      if (changed) {
        for (const groups of data.placements)
          for (const group of groups) group.count = 0;
        for (const i of querySpatial(scene.placements, seen)) {
          const offset = i * 4;
          const cell = scene.instances[offset]!;
          const mesh = data.cells[cell]!;
          if (!mesh.count) continue;
          const code = scene.instances[offset + 3]!;
          append(
            data.placements[cell]![
              (code < 4 ? 0 : 1) + (reach && far(mesh, offset) ? 2 : 0)
            ]!,
            scene.instances[offset + 1]! - ax,
            scene.instances[offset + 2]! - ay,
            code,
          );
        }
        data.grouped = { seen, eye, reach };
      }
      gl.uniform4f(uniforms.override!, 0, 0, 0, 0);
      data.cells.forEach((mesh, i) =>
        drawPlaced(mesh, data.placements[i]!, changed),
      );
      for (const i of querySpatial(scene.routing, seen)) drawMesh(data.top[i]!);
      gl.uniform4f(uniforms.override!, 0.3, 0.36, 0.42, 1);
      drawMesh(data.outline);
      if (data.highlight) {
        gl.uniform4f(uniforms.override!, 1, 1, 1, 1);
        drawMesh(data.highlight.mesh);
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
