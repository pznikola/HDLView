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
  overrides: Record<string, unknown>;
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
export interface WaveInfo {
  variables: Variable[];
  end_time: string;
  timescale: string;
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
