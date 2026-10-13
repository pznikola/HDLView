export type Representation = "elaborated" | "mapped" | "post_layout";
export interface Profile {
  provider: "native" | "docker";
  image?: string | null;
  executables?: Record<string, string>;
  plugins?: Record<string, string>;
  env?: Record<string, string>;
  pdk_root?: string | null;
  timeout_seconds?: number;
}
export interface ToolchainStatus {
  state:
    | "ready"
    | "docker_missing"
    | "docker_stopped"
    | "image_missing"
    | "image_old"
    | "unsupported";
  message: string;
  commands: string[];
  link: string | null;
}
export interface ToolchainReport {
  status: ToolchainStatus;
  tools: Record<string, string>;
}
export type SourceGroup = "design" | "simulation";
export type Technology = "sky130" | "ihp_sg13g2";
export interface PhysicalConfig {
  pdk: string;
  library: string;
  clock_port: string | null;
  clock_period_ns: number;
  additional_clocks?: { port: string; period_ns: number }[];
  related_clocks?: boolean;
  /** Mapped gates keeps the module hierarchy unless this is set. */
  flatten_mapped?: boolean;
  sdc?: FileRef | null;
  /** Absent: the flow sizes the block from the core utilization. */
  floorplan?: Floorplan | null;
  overrides: Record<string, unknown>;
}
export type Side = "north" | "east" | "south" | "west";
/** A fixed block outline; pins are in their order along each side. */
export interface Floorplan {
  width_um: number;
  height_um: number;
  pins: { port: string; side: Side }[];
}
/** [x0, y0, x1, y1] in database units. */
type LayoutBox = [number, number, number, number];
/** The routed block. Wire and power counts are per routing layer. */
export interface LayoutData {
  dbu: number;
  die: LayoutBox;
  core: LayoutBox;
  layers: string[];
  /** The via layers between them. */
  cuts: string[];
  /** A cell as its library describes it. */
  masters: { name: string; class: string; width: number; height: number }[];
  /** name, master index, box, orientation */
  instances: [string, number, number, number, number, number, string][];
  /** name, layer index, box, direction, signal type */
  pins: [string, number, number, number, number, number, string, string][];
  nets: string[];
  wires: number[];
  power: number[];
}
/** Boxes of one layer, each followed by the index of its net. */
export interface LayoutShapes {
  wires: [number, number, number, number, number][];
  power: [number, number, number, number, number][];
}
/** Flat x0, y0, x1, y1 boxes and flat x, y polygons, in database units. */
export interface MaskShapes {
  boxes: number[];
  polygons: number[][];
}
export interface MaskLayer {
  name: string;
  /** GDS layer/datatype. */
  source: string;
  fill: string;
  frame: string;
  /** Rows of the repeated fill bitmap, top row first; `*` is a set pixel. */
  pattern: string[];
  visible: boolean;
  /** The layer's position in the layer file, which shifts its pattern rows. */
  offset: number;
}
/** The final GDS with the PDK layer file's names, colours and patterns. */
export interface MaskData {
  dbu: number;
  top: string;
  box: LayoutBox;
  /** In drawing order, bottom first. */
  layers: MaskLayer[];
  /** A cell with its shapes by layer index, in its own coordinates. */
  cells: { name: string; box: LayoutBox; layers: Record<string, MaskShapes> }[];
  /** cell index, x, y, KLayout orientation code */
  instances: [number, number, number, number][];
  /** The top cell's own shapes, per layer. */
  shapes: MaskShapes[];
  /** layer index, x, y, text */
  labels: [number, number, number, string][];
}
/** Flat boxes and polygons as `[points, holeStarts]`, in database units. */
export interface SolidShapes {
  boxes: number[];
  polygons: [number[], number[]][];
}
export interface SolidMaterial {
  name: string;
  fill: string;
  /** GDS layer/datatype when the material shows one layer. */
  source: string | null;
}
/** Shapes of a material between two heights in µm. */
export interface SolidSlab {
  material: number;
  zstart: number;
  zstop: number;
}
/** The final GDS extruded with the PDK's 2.5D stack script. */
export interface SolidData {
  dbu: number;
  top: string;
  box: LayoutBox;
  /** In script order. */
  materials: SolidMaterial[];
  slabs: SolidSlab[];
  /** A cell with its shapes by slab index, in its own coordinates. */
  cells: { name: string; box: LayoutBox; slabs: Record<string, SolidShapes> }[];
  /** cell index, x, y, KLayout orientation code */
  instances: [number, number, number, number][];
  /** The top cell's own shapes, per slab. */
  shapes: SolidShapes[];
}
export interface Check {
  id: string;
  title: string;
  status: "clean" | "violations" | "not_run";
  count: number | null;
  /** Boxes are in microns. */
  rules?: {
    rule: string;
    description: string;
    count: number;
    boxes: LayoutBox[];
  }[];
  summary?: { devices: number[]; nets: number[] } | null;
  mismatches?: {
    kind: string;
    cell: string;
    layout: string[];
    netlist: string[];
  }[];
}
export interface Project {
  technology?: Technology | null;
  simulation_headers?: FileRef[];
  name: string;
  top: string;
  schema_version: number;
  standard: string;
  source_roots?: Record<string, string>;
  headers?: FileRef[];
  imports?: ImportRecord[];
  simulation_sources?: FileRef[];
  include_dirs: FileRef[];
  defines: Record<string, string>;
  parameters: Record<string, string>;
  assets: FileRef[];
  sources: { path: FileRef; language: Language }[];
  simulations: Record<string, SimulationConfig>;
  physical?: PhysicalConfig | null;
}
export interface SimulationConfig {
  simulator: "icarus" | "verilator";
  top: string;
  dut_scope: string[];
  testbench: FileRef[];
  models: FileRef[];
  sdf?: FileRef | null;
  stop_time: string;
  args: string[];
  defines: Record<string, string>;
  timing_corner?: string | null;
  delay_selection?: string | null;
  use_snapshot_sdf: boolean;
}
export type SettingsSection =
  | "general"
  | "sources"
  | "simulation"
  | "physical"
  | "editor";
export interface SettingsIssue {
  field: string;
  message: string;
}
export interface SettingsValidation {
  errors: SettingsIssue[];
  warnings: SettingsIssue[];
  matches_snapshot: boolean | null;
}
export type SettingsInputKind = "include_directory" | "model" | "sdc" | "sdf";
export interface SettingsReferences {
  project: Project;
  references: FileRef[];
}
export interface Snapshot {
  project_path?: string | null;
  project_fingerprint?: string | null;
  profile: Profile;
  id: string;
  representation: Representation;
  project: Project;
  directory: string;
  diagnostics: Diagnostic[];
  design: {
    scopes: { path: string[]; module: string }[];
    modules: Record<
      string,
      {
        ports: { name: string; direction: string; bits: unknown[] }[];
        cells: {
          name: string;
          kind: string;
          attributes: Record<string, unknown>;
        }[];
      }
    >;
  };
  sdf: Record<string, string>;
  physical_run?: {
    reports: string[];
    status: string;
    state: { metrics?: Record<string, unknown> };
    layout?: string | null;
    gds?: string | null;
    layer_file?: string | null;
    stack_file?: string | null;
    checks?: string | null;
  };
}
export interface Diagnostic {
  severity: string;
  message: string;
  source: string | null;
}
export interface Run {
  id: string;
  snapshot_id: string;
  representation: Representation;
  trace: string;
  directory: string;
  diagnostics: Diagnostic[];
  dut_scope: string[];
}
export interface Binding {
  signal_id: string;
  variable_ids: number[];
  status: string;
  evidence: string;
  /** The signal is this bit of the variable's value, counted from the right. */
  variable_bit?: number;
}
export interface Signal {
  id: string;
  path: string[];
  width: number;
  offset: number;
  upto: boolean;
  source: string | null;
}
export interface PinDisplay {
  name: string;
  width: number;
  bits: (number | string)[];
  role:
    | "data"
    | "select"
    | "clock"
    | "enable"
    | "reset"
    | "set"
    | "power"
    | "unused";
  polarity?: boolean | null;
  declared_direction?: string | null;
  range?: [number, number] | null;
  asynchronous: boolean;
}
/** What drives one contiguous run of an input pin, least significant run first. */
export type Feed =
  | { kind: "net"; edge: string; width: number; label: string }
  | { kind: "constant"; width: number; label: string }
  | { kind: "undriven"; width: number };
export interface NodeDisplay {
  symbol: string;
  title: string;
  annotations: string[];
  members: string[];
  internal_signal_ids: string[];
  detail?: string | null;
  /** Gates of a two-level cell: `first` over each pin group, then the other. */
  compound?: {
    first: string;
    groups: string[][];
    inverted: boolean;
  } | null;
}
export interface SchematicOptions {
  functional_symbols: boolean;
  show_physical_cells: boolean;
  detail?: string | null;
}
export interface Port {
  id: string;
  label: string;
  direction: string;
  signal_ids: string[];
  display: PinDisplay;
  feeds?: Feed[];
}
export interface Node {
  id: string;
  label: string;
  kind: string;
  ports: Port[];
  child_scope: string[] | null;
  source: string | null;
  display: NodeDisplay;
}
export interface Edge {
  id: string;
  sources: string[];
  targets: string[];
  signal_ids: string[];
  label: string;
  bits?: (number | string)[];
}
export interface Graph {
  nodes: Node[];
  edges: Edge[];
  signals: Signal[];
  truncated: boolean;
  total_cells: number;
  hidden_physical_cells: number;
  omitted_cells: number;
  detail?: string | null;
}
export interface Variable {
  id: number;
  path: string[];
  width: number;
  index?: [number, number];
}
/** One tick lasts `factor` × 10^`exponent` seconds. */
export interface Timescale {
  factor: number;
  exponent: number;
}
export interface WaveInfo {
  variables: Variable[];
  end_time: string;
  timescale?: Timescale | null;
}
export interface Transition {
  time: string;
  value: string;
}
export interface WaveRow {
  id: number;
  transitions: Transition[];
}
export interface Job {
  id: string;
  kind: string;
  status: string;
  error?: string;
  result?: unknown;
}

export type FileRef = string | { root: string; path: string };
export type Language = "system_verilog" | "verilog";
export type FileRole =
  | "design"
  | "header"
  | "simulation"
  | "simulation_header"
  | "remove";
export interface ImportRecord {
  group: SourceGroup;
  kind: "folder" | "filelist";
  location: FileRef;
  working_directory?: string | null;
  files: FileRef[];
  exclusions?: { path: FileRef; directory: boolean }[];
}
export interface WorkspaceProject {
  draft_id?: string | null;
  path: string;
  project: Project;
  revision: string;
}
export interface ImportRequest {
  group?: SourceGroup;
  kind: "files" | "folder" | "filelist";
  paths?: string[];
  working_directory?: string;
  record_index?: number;
}
export interface ImportEntry {
  file: FileRef;
  language: Language;
  role: FileRole;
  missing: boolean;
  excluded?: boolean;
}
export interface CreateFileEntry {
  directory: string;
  name: string;
  group: SourceGroup;
  folder: boolean;
}
export interface FileChange {
  file: FileRef;
  directory: boolean;
  kind: "rename" | "remove" | "trash";
  name?: string;
  open_files?: FileRef[];
}
export interface ReferenceChange {
  from: FileRef;
  to: FileRef | null;
}
export interface FileChangePreview {
  token: string;
  preview: {
    request: FileChange;
    location: string;
    affected: ReferenceChange[];
    simulations: string[];
    warnings: string[];
    blocked: string[];
    disk_revision: string;
  };
}
export interface FileChangeResult {
  workspace: WorkspaceProject;
  affected: ReferenceChange[];
  created: FileRef | null;
}
export interface ExplorerLocation {
  file: FileRef;
  location: string;
  exists: boolean;
  mutable: boolean;
}
export type FileDialog =
  | { kind: "create"; request: CreateFileEntry }
  | { kind: "rename"; request: FileChange }
  | { kind: "review"; result: FileChangePreview };
export interface ImportPreview {
  project: Project;
  entries: ImportEntry[];
  record?: ImportRecord | null;
  warnings: string[];
  replace_record?: number | null;
}
export interface PreviewResult {
  token: string;
  preview: ImportPreview;
}
export interface ImportChoice {
  index: number;
  role: FileRole;
  selected: boolean;
}
export interface SourceDocument {
  file: FileRef;
  text: string;
  revision: string;
  bom: boolean;
  line_ending: string;
}
export type SaveResult = {
  status: "saved" | "conflict";
  document: SourceDocument;
};

export interface RestoredProject {
  snapshot?: Snapshot | null;
  run_path?: string | null;
  stale: boolean;
  warnings: string[];
}

export type LintContext =
  | { kind: "design" }
  | { kind: "simulation"; configuration: string | null };
export interface WorkingBuffer {
  file: FileRef;
  text: string;
  version: number;
}
export interface EditorLintRequest {
  path: string;
  active_file: FileRef;
  context: LintContext;
  buffers: WorkingBuffer[];
  profile: Profile;
  generation: number;
  style: boolean;
}
export interface EditorLocation {
  file?: FileRef;
  from?: number;
  to?: number;
  line?: number;
  column?: number;
}
export interface EditorDiagnostic extends EditorLocation {
  severity: "error" | "warning" | "info" | "hint";
  engine: string;
  code: string;
  message: string;
  related: (EditorLocation & { message: string })[];
}
export interface EditorLintResult {
  generation: number;
  project_fingerprint: string;
  files: { file: FileRef; text_hash: string }[];
  engines: {
    engine: string;
    status: "complete" | "limited" | "failed" | "disabled";
    message: string | null;
  }[];
  diagnostics: EditorDiagnostic[];
  limited: boolean;
  truncated: boolean;
}
