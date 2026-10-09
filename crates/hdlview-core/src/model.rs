use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf};

pub const SCHEMA: u32 = 2;
pub const PROJECT_SCHEMA: u32 = 3;
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
    Elaborated,
    Mapped,
    PostLayout,
}
impl Representation {
    pub fn is_gate(&self) -> bool {
        matches!(self, Self::Mapped | Self::PostLayout)
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
#[serde(deny_unknown_fields)]
pub struct Clock {
    pub port: String,
    pub period_ns: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhysicalConfig {
    pub pdk: String,
    pub library: String,
    /// `None` for a design without a clock: its paths are timed against a
    /// virtual clock of `clock_period_ns`.
    pub clock_port: Option<String>,
    pub clock_period_ns: f64,
    /// Further clock ports, each with its own period.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub additional_clocks: Vec<Clock>,
    /// Time the paths between different clocks; they are asynchronous otherwise.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub related_clocks: bool,
    #[serde(default)]
    pub sdc: Option<FileRef>,
    #[serde(default)]
    pub overrides: BTreeMap<String, serde_json::Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Diagnostic {
    pub severity: String,
    pub message: String,
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
    pub offset: i64,
    pub upto: bool,
    pub signed: bool,
    pub hidden: bool,
    pub source: Option<String>,
}
impl Signal {
    /// Declared index of the bit at position `i`.
    pub fn index(&self, i: usize) -> i64 {
        self.offset
            + if self.upto {
                self.bits.len() - 1 - i
            } else {
                i
            } as i64
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Cell {
    pub name: String,
    pub kind: String,
    pub ports: Vec<Port>,
    pub source: Option<String>,
    pub attributes: BTreeMap<String, serde_json::Value>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub parameters: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Module {
    pub name: String,
    pub ports: Vec<Port>,
    pub signals: Vec<Signal>,
    pub cells: Vec<Cell>,
    pub blackbox: bool,
    /// What a library cell computes; absent for design modules.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub function: Option<CellFunction>,
}
/// A library cell's symbol and the meaning of its signal pins, derived from
/// its Liberty description.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct CellFunction {
    pub symbol: String,
    pub title: String,
    pub pins: BTreeMap<String, CellPin>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compound: Option<Compound>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct CellPin {
    pub role: PinRole,
    /// `Some(false)` is an inverted input or output, or an active-low control.
    pub polarity: Option<bool>,
    pub asynchronous: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}
/// A two-level cell: `first` gates over each group of pins, combined by the
/// other gate, with an optionally inverted output.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Compound {
    pub first: String,
    pub groups: Vec<Vec<String>>,
    pub inverted: bool,
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
impl Design {
    pub fn scope(&self, path: &[String]) -> Option<&Scope> {
        self.scopes.iter().find(|s| s.path == path)
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesignSnapshot {
    pub project_path: Option<PathBuf>,
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
    pub artifact_hashes: BTreeMap<String, String>,
    pub source_origins: BTreeMap<String, PathBuf>,
    pub netlist: Option<PathBuf>,
    pub sdf: BTreeMap<String, PathBuf>,
    pub physical_run: Option<PhysicalRun>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhysicalRun {
    pub status: String,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display: Option<NodeDisplay>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct NodeDisplay {
    pub symbol: String,
    pub title: String,
    pub annotations: Vec<String>,
    pub members: Vec<String>,
    pub internal_signal_ids: Vec<String>,
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compound: Option<Compound>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PinRole {
    #[default]
    Data,
    Select,
    Clock,
    Enable,
    Reset,
    Set,
    Power,
    /// A control tied to the constant that disables it; inspected, not drawn.
    Unused,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PinDisplay {
    pub name: String,
    pub width: usize,
    pub bits: Vec<Bit>,
    pub role: PinRole,
    pub polarity: Option<bool>,
    pub declared_direction: Option<String>,
    pub range: Option<(i64, i64)>,
    /// A reset, set or load that acts without the clock.
    pub asynchronous: bool,
}
/// What drives one contiguous run of an input pin.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Feed {
    /// `label` names the part of the driver taken, such as `[5:0]` or `[2] ×8`;
    /// it is empty when the run is the whole driver.
    Net {
        edge: String,
        width: usize,
        label: String,
    },
    Constant {
        width: usize,
        label: String,
    },
    Undriven {
        width: usize,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViewPort {
    pub id: String,
    pub label: String,
    pub direction: String,
    pub signal_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display: Option<PinDisplay>,
    /// Runs covering an input pin exactly, least significant first. Empty for
    /// outputs, inouts and pins of views that carry no bit connectivity.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub feeds: Vec<Feed>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViewEdge {
    pub id: String,
    pub sources: Vec<String>,
    pub targets: Vec<String>,
    pub signal_ids: Vec<String>,
    pub label: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bits: Vec<Bit>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SchematicOptions {
    pub functional_symbols: bool,
    pub show_physical_cells: bool,
    pub detail: Option<String>,
}
impl Default for SchematicOptions {
    fn default() -> Self {
        Self {
            functional_symbols: true,
            show_physical_cells: false,
            detail: None,
        }
    }
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
    pub hidden_physical_cells: usize,
    pub omitted_cells: usize,
    pub detail: Option<String>,
}

pub fn identity(snapshot: &str, path: &[String], kind: &str) -> String {
    format!(
        "{snapshot}:{kind}:{}",
        serde_json::to_string(path).expect("string path")
    )
}
