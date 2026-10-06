use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf};

pub const SCHEMA: u32 = 1;
pub const PROJECT_SCHEMA: u32 = 3;
pub const IMAGE: &str =
    "hpretl/iic-osic-tools@sha256:92961478ad3c4f508efb42d9ccdba12ab262eb42a14926d2bd49862230ba8521";
fn version() -> u32 {
    SCHEMA
}
fn std_sv() -> String {
    "1800-2017".into()
}
fn timeout() -> u64 {
    600
}
fn stop() -> String {
    "1us".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Language {
    Verilog,
    SystemVerilog,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Representation {
    Source,
    Elaborated,
    Generic,
    Mapped,
    PostLayout,
}
impl Representation {
    pub fn is_gate(&self) -> bool {
        matches!(self, Self::Generic | Self::Mapped | Self::PostLayout)
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(untagged)]
pub enum FileRef {
    Local(PathBuf),
    Rooted { root: String, path: PathBuf },
}
impl FileRef {
    pub fn path(&self) -> &std::path::Path {
        match self {
            Self::Local(path) | Self::Rooted { path, .. } => path,
        }
    }
    pub fn logical(&self) -> PathBuf {
        let path = match self {
            Self::Local(path) => path.clone(),
            Self::Rooted { root, path } => PathBuf::from("__roots").join(root).join(path),
        };
        let normalized: PathBuf = path
            .components()
            .filter(|c| !matches!(c, std::path::Component::CurDir))
            .collect();
        if normalized.as_os_str().is_empty() {
            PathBuf::from(".")
        } else {
            normalized
        }
    }
}
// Compiler-facing configurations contain only normalized Local references.
impl AsRef<std::path::Path> for FileRef {
    fn as_ref(&self) -> &std::path::Path {
        self.path()
    }
}
impl From<PathBuf> for FileRef {
    fn from(path: PathBuf) -> Self {
        Self::Local(path)
    }
}
impl From<&str> for FileRef {
    fn from(path: &str) -> Self {
        Self::Local(path.into())
    }
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum SourceGroup {
    #[default]
    Design,
    Simulation,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Technology {
    Sky130,
    IhpSg13g2,
}
impl Technology {
    pub fn preset(self) -> (&'static str, &'static str) {
        match self {
            Self::Sky130 => ("sky130A", "sky130_fd_sc_hd"),
            Self::IhpSg13g2 => ("ihp-sg13g2", "sg13g2_stdcell"),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportRecord {
    #[serde(default)]
    pub group: SourceGroup,
    pub kind: String,
    pub location: FileRef,
    #[serde(default)]
    pub working_directory: Option<PathBuf>,
    #[serde(default)]
    pub files: Vec<FileRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exclusions: Vec<ImportExclusion>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ImportExclusion {
    pub path: FileRef,
    pub directory: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceFile {
    pub path: FileRef,
    pub language: Language,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub technology: Option<Technology>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub simulation_headers: Vec<FileRef>,
    #[serde(default = "version")]
    pub schema_version: u32,
    pub name: String,
    pub top: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub source_roots: BTreeMap<String, PathBuf>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub headers: Vec<FileRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub imports: Vec<ImportRecord>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub simulation_sources: Vec<FileRef>,
    pub sources: Vec<SourceFile>,
    #[serde(default = "std_sv")]
    pub standard: String,
    #[serde(default)]
    pub include_dirs: Vec<FileRef>,
    #[serde(default)]
    pub defines: BTreeMap<String, String>,
    #[serde(default)]
    pub parameters: BTreeMap<String, String>,
    #[serde(default)]
    pub assets: Vec<FileRef>,
    #[serde(default)]
    pub simulations: BTreeMap<String, SimulationConfig>,
    #[serde(default)]
    pub physical: Option<PhysicalConfig>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    Native,
    Docker,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolchainProfile {
    pub provider: Provider,
    #[serde(default)]
    pub image: Option<String>,
    #[serde(default)]
    pub executables: BTreeMap<String, String>,
    #[serde(default)]
    pub plugins: BTreeMap<String, String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub pdk_root: Option<PathBuf>,
    #[serde(default = "timeout")]
    pub timeout_seconds: u64,
}
impl Default for ToolchainProfile {
    fn default() -> Self {
        Self {
            provider: Provider::Native,
            image: None,
            executables: BTreeMap::new(),
            plugins: BTreeMap::new(),
            env: BTreeMap::new(),
            pdk_root: None,
            timeout_seconds: timeout(),
        }
    }
}
impl ToolchainProfile {
    pub fn docker() -> Self {
        Self {
            provider: Provider::Docker,
            image: Some(IMAGE.into()),
            pdk_root: Some("/foss/pdks".into()),
            ..Self::default()
        }
    }
    pub fn exe(&self, name: &str) -> String {
        self.executables
            .get(name)
            .cloned()
            .unwrap_or_else(|| name.into())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Simulator {
    Icarus,
    Verilator,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SimulationConfig {
    pub simulator: Simulator,
    pub top: String,
    pub dut_scope: Vec<String>,
    pub testbench: Vec<FileRef>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default = "stop")]
    pub stop_time: String,
    #[serde(default)]
    pub sdf: Option<FileRef>,
    #[serde(default)]
    pub models: Vec<FileRef>,
    #[serde(default)]
    pub defines: BTreeMap<String, String>,
    #[serde(default)]
    pub timing_corner: Option<String>,
    #[serde(default)]
    pub delay_selection: Option<String>,
    #[serde(default)]
    pub use_snapshot_sdf: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhysicalConfig {
    pub pdk: String,
    pub library: String,
    pub clock_port: String,
    pub clock_period_ns: f64,
    #[serde(default)]
    pub sdc: Option<FileRef>,
    #[serde(default)]
    pub overrides: BTreeMap<String, serde_json::Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Diagnostic {
    pub severity: String,
    pub message: String,
    #[serde(default)]
    pub source: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(untagged)]
pub enum Bit {
    Wire(u64),
    Constant(String),
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Port {
    pub name: String,
    pub direction: String,
    pub bits: Vec<Bit>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Signal {
    pub name: String,
    pub bits: Vec<Bit>,
    #[serde(default)]
    pub offset: i64,
    #[serde(default)]
    pub upto: bool,
    #[serde(default)]
    pub signed: bool,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub source: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Cell {
    pub name: String,
    pub kind: String,
    pub ports: Vec<Port>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub attributes: BTreeMap<String, serde_json::Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Module {
    pub name: String,
    pub ports: Vec<Port>,
    pub signals: Vec<Signal>,
    pub cells: Vec<Cell>,
    #[serde(default)]
    pub blackbox: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Scope {
    pub path: Vec<String>,
    pub module: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Design {
    pub modules: BTreeMap<String, Module>,
    pub scopes: Vec<Scope>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesignSnapshot {
    #[serde(default)]
    pub project_path: Option<PathBuf>,
    #[serde(default)]
    pub project_fingerprint: Option<String>,
    pub schema_version: u32,
    pub id: String,
    pub representation: Representation,
    pub project: ProjectConfig,
    pub profile: ToolchainProfile,
    pub directory: PathBuf,
    pub design: Design,
    pub diagnostics: Vec<Diagnostic>,
    pub tool_versions: BTreeMap<String, String>,
    pub input_hashes: BTreeMap<String, String>,
    #[serde(default)]
    pub artifact_hashes: BTreeMap<String, String>,
    #[serde(default)]
    pub source_origins: BTreeMap<String, PathBuf>,
    pub netlist: Option<PathBuf>,
    #[serde(default)]
    pub sdf: BTreeMap<String, PathBuf>,
    #[serde(default)]
    pub physical_run: Option<PhysicalRun>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhysicalRun {
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub flow_error: Option<String>,
    pub directory: PathBuf,
    pub state: serde_json::Value,
    pub reports: Vec<PathBuf>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimulationRun {
    pub schema_version: u32,
    pub id: String,
    pub snapshot_id: String,
    pub representation: Representation,
    pub trace: PathBuf,
    pub trace_hash: String,
    pub dut_scope: Vec<String>,
    pub simulator: Option<Simulator>,
    pub diagnostics: Vec<Diagnostic>,
    pub directory: PathBuf,
    pub imported: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaveVariable {
    pub id: u32,
    pub path: Vec<String>,
    pub width: u32,
    pub index: Option<(i64, i64)>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaveInfo {
    pub variables: Vec<WaveVariable>,
    pub end_time: String,
    pub timescale: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transition {
    pub time: String,
    pub value: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaveRow {
    pub id: u32,
    pub transitions: Vec<Transition>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalBinding {
    pub signal_id: String,
    pub variable_ids: Vec<u32>,
    pub status: String,
    pub evidence: String,
    pub bit_correspondence: Vec<(i64, i64)>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViewNode {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub ports: Vec<ViewPort>,
    pub child_scope: Option<Vec<String>>,
    pub source: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViewPort {
    pub id: String,
    pub label: String,
    pub direction: String,
    pub signal_ids: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViewEdge {
    pub id: String,
    pub sources: Vec<String>,
    pub targets: Vec<String>,
    pub signal_ids: Vec<String>,
    pub label: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalRef {
    pub id: String,
    pub path: Vec<String>,
    pub width: usize,
    pub offset: i64,
    pub upto: bool,
    pub source: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphView {
    pub nodes: Vec<ViewNode>,
    pub edges: Vec<ViewEdge>,
    pub signals: Vec<SignalRef>,
    pub truncated: bool,
    pub total_cells: usize,
}

pub fn identity(snapshot: &str, path: &[String], kind: &str) -> String {
    format!(
        "{snapshot}:{kind}:{}",
        serde_json::to_string(path).expect("string path")
    )
}
