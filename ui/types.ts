export type Representation =
  | "source"
  | "elaborated"
  | "generic"
  | "mapped"
  | "post_layout";
export interface Profile {
  provider: "native" | "docker";
  image?: string | null;
  executables?: Record<string, string>;
  plugins?: Record<string, string>;
  env?: Record<string, string>;
  pdk_root?: string | null;
  timeout_seconds?: number;
}
export interface Project {
  name: string;
  top: string;
  sources: { path: string; language: string }[];
  simulations: Record<string, unknown>;
  physical?: unknown;
}
export interface Snapshot {
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
  source?: string;
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
}
export interface Signal {
  id: string;
  path: string[];
  width: number;
  offset: number;
  upto: boolean;
  source?: string;
}
export interface Port {
  id: string;
  label: string;
  direction: string;
  signal_ids: string[];
}
export interface Node {
  id: string;
  label: string;
  kind: string;
  ports: Port[];
  child_scope?: string[];
  source?: string;
}
export interface Edge {
  id: string;
  sources: string[];
  targets: string[];
  signal_ids: string[];
  label: string;
}
export interface Graph {
  nodes: Node[];
  edges: Edge[];
  signals: Signal[];
  truncated: boolean;
  total_cells: number;
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
