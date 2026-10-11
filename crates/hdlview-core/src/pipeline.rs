use crate::{graph, library, model::*, project::*, runner::*};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

fn q(path: &Path) -> Result<String> {
    yosys_quote(&path.to_string_lossy())
}
/// Whether Yosys has a command built in, asked once per toolchain identity.
static BUILT_IN: Mutex<BTreeMap<(String, String), bool>> = Mutex::new(BTreeMap::new());
fn plugin(r: &Runner, name: &str, command: &str) -> Result<Vec<String>> {
    let key = (r.toolchain_key(), command.to_owned());
    let known = BUILT_IN.lock().unwrap().get(&key).copied();
    let built_in = match known {
        Some(answer) => answer,
        None => {
            let help = r.run(
                "yosys",
                &[
                    "-Q".into(),
                    "-T".into(),
                    "-p".into(),
                    format!("help {command}"),
                ],
                &r.workspace,
                "capability",
            )?;
            let answer = !help.contains("No such command");
            BUILT_IN.lock().unwrap().insert(key, answer);
            answer
        }
    };
    if built_in {
        return Ok(vec![]);
    }
    Ok(vec![
        "-m".into(),
        r.profile
            .plugins
            .get(name)
            .cloned()
            .unwrap_or_else(|| name.into()),
    ])
}
fn yosys(r: &Runner, script: &str, plugins: Vec<String>, label: &str) -> Result<String> {
    let path = r.workspace.join(format!("{label}.ys"));
    fs::write(&path, script)?;
    let mut args = plugins;
    args.extend([
        "-Q".into(),
        "-T".into(),
        "-s".into(),
        path.to_string_lossy().into(),
    ]);
    r.run("yosys", &args, &r.workspace, label)
}
fn frontend(r: &Runner, p: &ProjectConfig) -> Result<(String, Vec<String>)> {
    let inputs = r.workspace.join("inputs");
    let mut script = String::new();
    let plugins = {
        let plugins = plugin(r, "slang", "read_slang")?;
        script.push_str(&format!(
            "--keep-hierarchy --std={} --top {} ",
            p.standard,
            identifier(&p.top)?
        ));
        for dir in &p.include_dirs {
            script.push_str(&format!("-I {} ", q(&inputs.join(dir))?));
        }
        for (k, v) in &p.defines {
            script.push_str(&format!("-D {} ", yosys_quote(&format!("{k}={v}"))?));
        }
        for (k, v) in &p.parameters {
            script.push_str(&format!("-G {} ", yosys_quote(&format!("{k}={v}"))?));
        }
        for s in &p.sources {
            script.push_str(&format!("{} ", q(&inputs.join(&s.path))?));
        }
        fs::write(r.workspace.join("frontend.f"), &script)?;
        script = "read_slang -F frontend.f\n".into();
        plugins
    };
    script.push_str(&format!(
        "hierarchy -check -top {}\nproc\nmemory_collect\ncheck\n",
        identifier(&p.top)?
    ));
    Ok((script, plugins))
}
/// Cleanup for the drawn elaborated netlist only; `elaborated.il` and `normalized.v`
/// remain the synthesis inputs. Every restriction protects something users can see:
/// - `keep` on declared wires, because `opt_clean` otherwise drops unloaded signals
///   that waveform binding still needs;
/// - `-keepdc`, so a register with a constant or self-fed D is not replaced by a constant;
/// - `-simple-dffe`, so enable inference never invents comparison cells;
/// - no enable/reset folding through a declared D net, which would duplicate its logic;
/// - width reduction for arithmetic only, so comparators keep their declared operands.
const VIEW_CLEANUP: &str = "read_rtlil elaborated.il
setattr -set keep 1 w:* w:$* %d
opt_expr -mux_undef -noclkinv
opt_clean
opt_dff -keepdc -nodffe -nosdff
select -set declared_d w:* w:$* %d %co1:+[D] c:* %i
opt_dff -keepdc -simple-dffe c:* @declared_d %d
opt_expr -mux_undef -noclkinv
opt_clean
wreduce -keepdc t:$add t:$sub t:$mul
opt_clean
write_json elaborated-view.json
";
pub fn compile(
    project_path: &Path,
    profile: ToolchainProfile,
    representation: Representation,
    store: &Path,
    cancel: CancelToken,
) -> Result<DesignSnapshot> {
    compile_directory(project_path, profile, representation, store, cancel, None)
}
pub fn resume_physical(directory: &Path, cancel: CancelToken) -> Result<DesignSnapshot> {
    let directory = directory.canonicalize()?;
    if directory.join("snapshot.json").exists() {
        bail!("Snapshot already published; open it instead")
    }
    compile_directory(
        &directory.join("project.json"),
        read_json(&directory.join("toolchain.json"))?,
        Representation::PostLayout,
        &directory,
        cancel,
        Some(directory.clone()),
    )
}
fn compile_directory(
    project_path: &Path,
    profile: ToolchainProfile,
    representation: Representation,
    store: &Path,
    cancel: CancelToken,
    resume: Option<PathBuf>,
) -> Result<DesignSnapshot> {
    let mut project = if resume.is_some() {
        let captured: ProjectConfig = read_json(project_path)?;
        validate_captured(&captured)?;
        captured
    } else {
        let project = load_project(project_path)?;
        validate_build(&project)?;
        project
    };
    let profile = resolve_profile(profile)?;
    let resuming = resume.is_some();
    let dir = match resume {
        Some(path) => path,
        None => unique_dir(store, "design")?,
    };
    let origin_file = dir.join("project-origin.json");
    let origin: (Option<PathBuf>, Option<String>) = if resuming {
        read_json(&origin_file)?
    } else {
        (
            Some(project_path.canonicalize()?),
            Some(hash(serde_json::to_vec(&project)?)),
        )
    };
    if !resuming {
        atomic_json(&origin_file, &origin)?;
    }
    let original_path = &origin.0;
    let mut source_origins = BTreeMap::new();
    let inputs = if resuming {
        let hashes: BTreeMap<String, String> = read_json(&dir.join("input-hashes.json"))?;
        for (name, expected) in &hashes {
            relative(Path::new(name))?;
            if file_hash(&dir.join("inputs").join(name))? != *expected {
                bail!("Captured input changed: {name}")
            }
        }
        hashes
    } else {
        let captured = capture(project_path, &project, &dir)?;
        project = captured.project;
        source_origins = captured.origins;
        captured.hashes
    };
    atomic_json(&dir.join("toolchain.json"), &profile)?;
    let runner = Runner::new(profile.clone(), dir.clone(), cancel);
    let tool_versions = runner.versions();
    runner.cancel.check()?;
    // Docker's immutable image covers compiler/plugin/model contents. External
    // native installations and mounted PDKs are conservatively rebuilt.
    let cache_key = if !resuming
        && matches!(profile.provider, Provider::Docker)
        && !profile.pdk_root.as_ref().is_some_and(|p| p.exists())
    {
        static APPLICATION: OnceLock<String> = OnceLock::new();
        let application = match APPLICATION.get() {
            Some(known) => known.clone(),
            None => {
                let found = file_hash(&std::env::current_exe()?).context(
                    "Fingerprint application; restart HDLView if its executable was rebuilt",
                )?;
                APPLICATION.get_or_init(|| found).clone()
            }
        };
        Some(hash(serde_json::to_vec(
            &json!({"project":project,"profile":profile,"representation":representation,"inputs":inputs,"tools":tool_versions,"application":application,"origins":source_origins,"project_path":original_path}),
        )?))
    } else {
        None
    };
    if let Some(key) = &cache_key {
        let index = store.join("cache").join(format!("{key}.json"));
        if index.exists() {
            if let Ok(path) = read_json::<PathBuf>(&index) {
                if let Ok(cached) = read_snapshot(&path) {
                    if cached.representation == representation && cached.input_hashes == inputs {
                        // This build's capture is not needed; failed builds keep theirs for the logs.
                        let _ = fs::remove_dir_all(&dir);
                        return Ok(cached);
                    }
                }
            }
        }
    }
    let mut diagnostics = Vec::new();
    let mut netlist = None;
    let mut sdf = BTreeMap::new();
    let mut physical_run = None;
    if !resuming {
        let (mut script, plugins) = frontend(&runner, &project)?;
        script.push_str("write_rtlil elaborated.il\nwrite_json elaborated.json\nwrite_verilog -noattr normalized.v\n");
        let log = yosys(&runner, &script, plugins, "elaborate")?;
        diagnostics.extend(diagnostics_from_log(&log));
    }
    let design = match representation {
        Representation::Elaborated => {
            yosys(&runner, VIEW_CLEANUP, vec![], "view")?;
            graph::from_yosys_text(
                &fs::read_to_string(dir.join("elaborated-view.json"))?,
                &project.top,
            )?
        }
        Representation::Mapped | Representation::PostLayout => {
            let physical = run_physical(
                &runner,
                &project,
                representation == Representation::Mapped,
                &mut diagnostics,
            )?;
            let state = &physical.state;
            let nl = state
                .get("nl")
                .and_then(Value::as_str)
                .context("LibreLane did not produce an nl artifact")?;
            let source = PathBuf::from(nl);
            let finalfile = dir.join("netlist.v");
            fs::copy(&source, &finalfile)
                .with_context(|| format!("Copy LibreLane netlist {nl}"))?;
            if let Some(values) = state.get("sdf").and_then(Value::as_object) {
                for (corner, path) in values {
                    if let Some(path) = path.as_str() {
                        let dest = dir.join(format!("{}.sdf", hash(corner)));
                        fs::copy(path, &dest)?;
                        sdf.insert(corner.clone(), dest);
                    }
                }
            }
            let pdk = project.physical.as_ref().unwrap();
            let libs = library_files(&runner.profile, pdk)?;
            let mut script = String::new();
            for lib in &libs {
                script.push_str(&format!("read_liberty -lib {}\n", q(lib)?));
            }
            fs::write(
                dir.join("library_interfaces.py"),
                include_str!("../../../tools/library_interfaces.py"),
            )?;
            let mut args = vec![
                dir.join("library_interfaces.py").to_string_lossy().into(),
                dir.join("library_interfaces.v").to_string_lossy().into(),
            ];
            args.extend(
                model_files(&runner.profile, pdk)?
                    .iter()
                    .map(|p| p.to_string_lossy().into_owned()),
            );
            runner.run("python3", &args, &dir, "library-interfaces")?;
            script.push_str("read_verilog -lib -overwrite library_interfaces.v\n");
            if let Some(error) = &physical.flow_error {
                diagnostics.push(Diagnostic {
                    severity: "error".into(),
                    message: format!("Physical flow completed with failed checks: {error}"),
                    source: None,
                });
            }
            script.push_str(&format!(
                "read_verilog {}\nhierarchy -check -top {}\nwrite_json graph.json\n",
                q(&finalfile)?,
                project.top
            ));
            diagnostics.extend(diagnostics_from_log(&yosys(
                &runner,
                &script,
                vec![],
                "import-mapped",
            )?));
            netlist = Some(finalfile);
            physical_run = Some(physical);
            let mut design =
                graph::from_yosys_text(&fs::read_to_string(dir.join("graph.json"))?, &project.top)?;
            // Symbols and pin roles come from the library's own functions.
            let mut functions = library_functions(&runner, &libs)?;
            // Only library cells: a design module may share a cell's name.
            for (name, module) in design.modules.iter_mut().filter(|(_, m)| m.blackbox) {
                // Fill and tap cells have no Liberty entry and no signal pins.
                let function = functions.remove(name).or_else(|| library::physical(module));
                module.function = function;
            }
            design
        }
    };
    let netlist_hash = netlist.as_ref().map(|p| file_hash(p)).transpose()?;
    let id = hash(serde_json::to_vec(
        &json!({"project":project,"profile":profile,"representation":representation,"inputs":inputs,"tools":tool_versions,"design":design,"netlist":netlist_hash,"sdf":sdf.iter().map(|(k,p)|Ok((k,file_hash(p)?))).collect::<Result<BTreeMap<_,_>>>()?}),
    )?);
    let mut artifact_hashes = BTreeMap::new();
    for path in netlist.iter().chain(sdf.values()) {
        artifact_hashes.insert(
            path.strip_prefix(&dir)?.to_string_lossy().into_owned(),
            file_hash(path)?,
        );
    }
    artifact_hashes.insert("project-origin.json".into(), file_hash(&origin_file)?);
    let origins_file = dir.join("source-origins.json");
    source_origins = read_json(&origins_file)?;
    artifact_hashes.insert("source-origins.json".into(), file_hash(&origins_file)?);
    let snapshot = DesignSnapshot {
        project_path: origin.0,
        project_fingerprint: origin.1,
        source_origins,
        artifact_hashes,
        schema_version: SCHEMA,
        id,
        representation,
        project,
        profile,
        directory: dir.clone(),
        design,
        diagnostics,
        tool_versions,
        input_hashes: inputs,
        netlist,
        sdf,
        physical_run,
    };
    atomic_json(&dir.join("snapshot.json"), &snapshot)?;
    if let Some(key) = cache_key {
        let cache = store.join("cache");
        fs::create_dir_all(&cache)?;
        atomic_json(
            &cache.join(format!("{key}.json")),
            &dir.join("snapshot.json"),
        )?;
    }
    Ok(snapshot)
}
pub fn diagnostics_from_log(log: &str) -> Vec<Diagnostic> {
    log.lines()
        .filter(|l| {
            let s = l.to_ascii_lowercase();
            s.contains("warning") || s.contains("error") || s.contains("unsupported")
        })
        .take(1000)
        .map(|l| Diagnostic {
            severity: if l.contains("Build succeeded:") {
                "info"
            } else if l.to_ascii_lowercase().contains("error") {
                "error"
            } else {
                "warning"
            }
            .into(),
            message: l.into(),
            source: None,
        })
        .collect()
}
/// Read each Liberty cell as the gates of its function. Cells whose function
/// Liberty does not state are skipped and remain unknown boxes.
fn library_functions(r: &Runner, libs: &[PathBuf]) -> Result<BTreeMap<String, CellFunction>> {
    let mut script = String::new();
    for lib in libs {
        script.push_str(&format!(
            "read_liberty -overwrite -ignore_miss_func -ignore_miss_dir -ignore_miss_data_latch -ignore_buses {}\n",
            q(lib)?
        ));
    }
    script.push_str("write_json library-functions.json\n");
    yosys(r, &script, vec![], "library-functions")?;
    let json: Value = read_json(&r.workspace.join("library-functions.json"))?;
    Ok(library::functions(&graph::modules_from_yosys(&json)?))
}
fn pdk_root(profile: &ToolchainProfile) -> PathBuf {
    profile
        .pdk_root
        .clone()
        .unwrap_or_else(|| "/foss/pdks".into())
}
fn library_files(profile: &ToolchainProfile, p: &PhysicalConfig) -> Result<Vec<PathBuf>> {
    let root = pdk_root(profile);
    let lib=match(p.pdk.as_str(),p.library.as_str()) {
  ("sky130A","sky130_fd_sc_hd")=>root.join("sky130A/libs.ref/sky130_fd_sc_hd/lib/sky130_fd_sc_hd__tt_025C_1v80.lib"),
  ("ihp-sg13g2","sg13g2_stdcell")=>root.join("ihp-sg13g2/libs.ref/sg13g2_stdcell/lib/sg13g2_stdcell_typ_1p20V_25C.lib"),
  _=>bail!("Unsupported PDK/library preset; use sky130A/sky130_fd_sc_hd or ihp-sg13g2/sg13g2_stdcell"),
 };
    Ok(vec![lib])
}
/// The layer names, colours and fill patterns KLayout shows for a PDK.
fn layer_properties(profile: &ToolchainProfile, p: &PhysicalConfig) -> PathBuf {
    pdk_root(profile).join(match p.pdk.as_str() {
        "ihp-sg13g2" => "ihp-sg13g2/libs.tech/klayout/tech/sg13g2.lyp",
        _ => "sky130A/libs.tech/klayout/tech/sky130A.lyp",
    })
}
/// The heights, thicknesses and colours KLayout's 2.5D view gives a PDK's layers.
fn layer_stack(profile: &ToolchainProfile, p: &PhysicalConfig) -> PathBuf {
    pdk_root(profile).join(match p.pdk.as_str() {
        "ihp-sg13g2" => "ihp-sg13g2/libs.tech/klayout/tech/d25/sg13g2_beol.lyd25",
        _ => "sky130A/libs.tech/klayout/d25/sky130.lyd25",
    })
}
pub fn model_files(profile: &ToolchainProfile, p: &PhysicalConfig) -> Result<Vec<PathBuf>> {
    let root = pdk_root(profile);
    match p.pdk.as_str() {
        "sky130A" => Ok(vec![
            root.join("sky130A/libs.ref/sky130_fd_sc_hd/verilog/primitives.v"),
            root.join("sky130A/libs.ref/sky130_fd_sc_hd/verilog/sky130_fd_sc_hd.v"),
        ]),
        "ihp-sg13g2" => {
            Ok(vec![root.join(
                "ihp-sg13g2/libs.ref/sg13g2_stdcell/verilog/sg13g2_stdcell.v",
            )])
        }
        _ => bail!("Unsupported PDK model preset"),
    }
}
/// The clocks beside the primary one, checked: they need a primary clock, distinct
/// simple port names and positive periods.
pub(crate) fn additional_clocks(cfg: &PhysicalConfig) -> Result<&[Clock]> {
    let mut ports = vec![cfg.clock_port.as_deref()];
    for clock in &cfg.additional_clocks {
        identifier(&clock.port)?;
        if cfg.clock_port.is_none() {
            bail!("Set the clock port before adding further clocks")
        }
        if ports.contains(&Some(clock.port.as_str())) {
            bail!("Clock port {} is listed twice", clock.port)
        }
        if !clock.period_ns.is_finite() || clock.period_ns <= 0.0 {
            bail!("Clock period of {} must be positive", clock.port)
        }
        ports.push(Some(&clock.port));
    }
    Ok(&cfg.additional_clocks)
}
/// The statements of LibreLane's `base.sdc` that do not name a clock.
const SDC_COMMON: &str = r#"set_max_fanout $::env(MAX_FANOUT_CONSTRAINT) [current_design]
if { [info exists ::env(MAX_TRANSITION_CONSTRAINT)] } {
    set_max_transition $::env(MAX_TRANSITION_CONSTRAINT) [current_design]
}
if { [info exists ::env(MAX_CAPACITANCE_CONSTRAINT)] } {
    set_max_capacitance $::env(MAX_CAPACITANCE_CONSTRAINT) [current_design]
}
if { ![info exists ::env(SYNTH_CLK_DRIVING_CELL)] } {
    set ::env(SYNTH_CLK_DRIVING_CELL) $::env(SYNTH_DRIVING_CELL)
}
set_driving_cell \
    -lib_cell [lindex [split $::env(SYNTH_DRIVING_CELL) "/"] 0] \
    -pin [lindex [split $::env(SYNTH_DRIVING_CELL) "/"] 1] \
    $data_inputs
set_driving_cell \
    -lib_cell [lindex [split $::env(SYNTH_CLK_DRIVING_CELL) "/"] 0] \
    -pin [lindex [split $::env(SYNTH_CLK_DRIVING_CELL) "/"] 1] \
    $clock_ports
set_load [expr $::env(OUTPUT_CAP_LOAD) / 1000.0] [all_outputs]
set_clock_uncertainty $::env(CLOCK_UNCERTAINTY_CONSTRAINT) [all_clocks]
set_clock_transition $::env(CLOCK_TRANSITION_CONSTRAINT) [all_clocks]
set_timing_derate -early [expr 1-[expr $::env(TIME_DERATING_CONSTRAINT) / 100]]
set_timing_derate -late [expr 1+[expr $::env(TIME_DERATING_CONSTRAINT) / 100]]
if { [info exists ::env(OPENLANE_SDC_IDEAL_CLOCKS)] && $::env(OPENLANE_SDC_IDEAL_CLOCKS) } {
    unset_propagated_clock [all_clocks]
} else {
    set_propagated_clock [all_clocks]
}
"#;
/// Constraints for several clocks. LibreLane's own `base.sdc` constrains only the
/// first clock; this follows it, for every clock.
fn clocks_sdc(clocks: &[(&str, f64)], related: bool) -> String {
    let mut sdc = String::from("# Written by HDLView for a design with several clocks.\n");
    for (port, period) in clocks {
        sdc.push_str(&format!(
            "create_clock [get_ports {{{port}}}] -name {{{port}}} -period {period}\n"
        ));
    }
    if !related {
        sdc.push_str("set_clock_groups -asynchronous");
        for (port, _) in clocks {
            sdc.push_str(&format!(" -group {{{port}}}"));
        }
        sdc.push('\n');
    }
    let names = clocks
        .iter()
        .map(|(port, _)| *port)
        .collect::<Vec<_>>()
        .join(" ");
    sdc.push_str(&format!(
        "set clock_ports [get_ports {{{names}}}]\nset data_inputs [all_inputs]\nforeach port $clock_ports {{\n    set index [lsearch $data_inputs $port]\n    if {{ $index >= 0 }} {{ set data_inputs [lreplace $data_inputs $index $index] }}\n}}\n"
    ));
    for (port, period) in clocks {
        sdc.push_str(&format!(
            "set io_delay [expr {period} * $::env(IO_DELAY_CONSTRAINT) / 100]\nset_input_delay $io_delay -clock [get_clocks {{{port}}}] -add_delay $data_inputs\nset_output_delay $io_delay -clock [get_clocks {{{port}}}] -add_delay [all_outputs]\n"
        ));
    }
    sdc + SDC_COMMON
}
/// Room beside one strap set for row and site snapping.
const STRAP_MARGIN: f64 = 1.25;
/// The shortest side that holds one set of power straps.
fn strap_side(resolved: &Value) -> Option<f64> {
    let number = |key: String| {
        let value = &resolved[key.as_str()];
        value
            .as_f64()
            .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
    };
    let straps = |axis: &str| {
        Some(
            number(format!("PDN_{axis}OFFSET"))?
                + 2.0 * number(format!("PDN_{axis}WIDTH"))?
                + number(format!("PDN_{axis}SPACING"))?,
        )
    };
    Some(straps("V")?.max(straps("H")?) * STRAP_MARGIN)
}
/// The power grid needs a core at least one strap set wide and high. Returns a
/// lower core utilization when the synthesized cells would get a smaller core.
fn fitting_utilization(cell_area: f64, utilization: f64, resolved: &Value) -> Option<f64> {
    let side = strap_side(resolved)?;
    let fitting = cell_area / (side * side) * 100.0;
    (cell_area > 0.0 && fitting < utilization).then_some(fitting)
}
fn librelane_args(r: &Runner, cfg: &PhysicalConfig, tag: &str, to: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "--manual-pdk".into(),
        "--pdk-root".into(),
        pdk_root(&r.profile).to_string_lossy().into(),
        "--pdk".into(),
        cfg.pdk.clone(),
        "--scl".into(),
        cfg.library.clone(),
        "--flow".into(),
        "Classic".into(),
        "--run-tag".into(),
        tag.into(),
    ];
    if let Some(step) = to {
        args.extend(["--to".into(), step.into()]);
    }
    args.push(r.workspace.join("librelane.json").to_string_lossy().into());
    args
}
fn run_physical(
    r: &Runner,
    p: &ProjectConfig,
    synthesis_only: bool,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<PhysicalRun> {
    let cfg = p
        .physical
        .as_ref()
        .context("A physical configuration is required for mapped/post-layout builds")?;
    if let Some(port) = &cfg.clock_port {
        identifier(port)?;
    }
    if !cfg.clock_period_ns.is_finite() || cfg.clock_period_ns <= 0.0 {
        bail!("Clock period must be positive")
    }
    let mut clocks: Vec<(&str, f64)> = cfg
        .clock_port
        .iter()
        .map(|port| (port.as_str(), cfg.clock_period_ns))
        .collect();
    clocks.extend(
        additional_clocks(cfg)?
            .iter()
            .map(|clock| (clock.port.as_str(), clock.period_ns)),
    );
    library_files(&r.profile, cfg)?;
    let mut config = serde_json::Map::new();
    config.insert("DESIGN_NAME".into(), json!(p.top));
    config.insert(
        "VERILOG_FILES".into(),
        json!([r.workspace.join("normalized.v")]),
    );
    // No port: LibreLane times the design against a virtual clock of the period.
    config.insert(
        "CLOCK_PORT".into(),
        match clocks.as_slice() {
            [] => Value::Null,
            [(port, _)] => json!(port),
            _ => json!(clocks.iter().map(|(port, _)| port).collect::<Vec<_>>()),
        },
    );
    // Synthesis targets the fastest clock.
    config.insert(
        "CLOCK_PERIOD".into(),
        json!(clocks
            .iter()
            .map(|(_, period)| *period)
            .fold(cfg.clock_period_ns, f64::min)),
    );
    config.insert("FP_CORE_UTIL".into(), json!(30));
    config.insert("PL_TARGET_DENSITY_PCT".into(), json!(40));
    if cfg.pdk == "ihp-sg13g2" {
        // Magic's rules for this PDK reject its own `sg13g2_tiehi` cell (pSD.i,
        // pSD.j); IHP's KLayout deck is the reference and still runs.
        config.insert("RUN_MAGIC_DRC".into(), json!(false));
    }
    let sdc = match &cfg.sdc {
        Some(sdc) => Some(r.workspace.join("inputs").join(sdc)),
        None if clocks.len() > 1 => {
            let path = r.workspace.join("constraints.sdc");
            fs::write(&path, clocks_sdc(&clocks, cfg.related_clocks))?;
            Some(path)
        }
        None => None,
    };
    if let Some(sdc) = sdc {
        config.insert("PNR_SDC_FILE".into(), json!(sdc));
        config.insert("SIGNOFF_SDC_FILE".into(), json!(sdc));
    }
    if synthesis_only && !cfg.flatten_mapped {
        // Place and route flattens whatever it is given, so only the Mapped
        // gates netlist can keep the modules.
        config.insert("SYNTH_HIERARCHY_MODE".into(), json!("keep"));
    }
    for (k, v) in &cfg.overrides {
        if ["DESIGN_NAME", "VERILOG_FILES", "PDK", "STD_CELL_LIBRARY"].contains(&k.as_str()) {
            bail!("Reserved physical configuration key {k}")
        }
        config.insert(k.clone(), v.clone());
    }
    crate::floorplan::check(cfg)?;
    if let Some(plan) = &cfg.floorplan {
        config.insert("FP_SIZING".into(), json!("absolute"));
        config.insert(
            "DIE_AREA".into(),
            json!([0, 0, plan.width_um, plan.height_um]),
        );
        let elaborated = read_json(&r.workspace.join("elaborated.json"))?;
        let modules = graph::modules_from_yosys(&elaborated)?;
        let ports = &modules.get(&p.top).context("No top module")?.ports;
        if let Some(order) = crate::floorplan::pin_order(plan, &p.top, ports)? {
            let path = r.workspace.join("pins.cfg");
            fs::write(&path, order)?;
            config.insert("IO_PIN_ORDER_CFG".into(), json!(path));
            config.insert("ERRORS_ON_UNMATCHED_IO".into(), json!("both"));
        }
    }
    let configpath = r.workspace.join("librelane.json");
    let published = r.workspace.join("runs/hdlview/final/nl").is_dir();
    let floorplan_is_set = ["FP_SIZING", "DIE_AREA", "CORE_AREA"]
        .iter()
        .any(|key| cfg.overrides.contains_key(*key));
    if !synthesis_only && !published && !floorplan_is_set {
        // Synthesize first: only the cell area tells whether the default floorplan
        // is large enough for the power grid.
        atomic_json(&configpath, &config)?;
        let args = librelane_args(r, cfg, "hdlview-size", Some("Yosys.Synthesis"));
        r.run("librelane", &args, &r.workspace, "librelane-size")?;
        let run = r.workspace.join("runs/hdlview-size");
        let mut states = Vec::new();
        collect_artifacts(&run, &mut states, &mut Vec::new())?;
        let state = states
            .iter()
            .find(|path| {
                path.parent()
                    .is_some_and(|step| step.to_string_lossy().ends_with("-yosys-synthesis"))
            })
            .context("LibreLane synthesis left no state")?;
        let area = read_json::<Value>(state)?["metrics"]["design__instance__area"].as_f64();
        let utilization = config["FP_CORE_UTIL"].as_f64();
        if let (Some(area), Some(utilization)) = (area, utilization) {
            let resolved = read_json(&run.join("resolved.json"))?;
            if let Some(plan) = &cfg.floorplan {
                let refusal =
                    crate::floorplan::too_small(plan, area, utilization, strap_side(&resolved));
                if let Some(refusal) = refusal {
                    let _ = fs::remove_dir_all(&run);
                    bail!(refusal)
                }
            } else if let Some(fitting) = fitting_utilization(area, utilization, &resolved) {
                config.insert("FP_CORE_UTIL".into(), json!(fitting));
                diagnostics.push(Diagnostic {
                    severity: "info".into(),
                    message: format!("Design is small: core utilization lowered from {utilization} % to {fitting:.1} % so the power grid fits"),
                    source: None,
                });
            }
        }
        // Only the area and the grid values were needed; the log stays under `logs`.
        let _ = fs::remove_dir_all(&run);
    }
    atomic_json(&configpath, &config)?;
    let args = librelane_args(
        r,
        cfg,
        "hdlview",
        synthesis_only.then_some("Yosys.Synthesis"),
    );
    let outcome = if published {
        let mut records = fs::read_dir(r.workspace.join("logs"))?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                p.file_name()
                    .is_some_and(|n| n.to_string_lossy().ends_with("-librelane.command.json"))
            })
            .collect::<Vec<_>>();
        records.sort();
        let previous: CommandRecord =
            read_json(records.last().context("No physical command manifest")?)?;
        if previous.exit_code == Some(0) {
            Ok(String::new())
        } else {
            Err(anyhow::anyhow!("Published physical artifacts from a run with failed checks; inspect reports and original flow log"))
        }
    } else {
        r.run("librelane", &args, &r.workspace, "librelane")
    };
    r.cancel.check()?;
    // LibreLane publishes final views even when deferred signoff checks fail.
    // Preserve that failure independently of successful artifact import.
    let flow_error = match outcome {
        Ok(_) => None,
        Err(error) => {
            if !r.workspace.join("runs/hdlview/final/nl").is_dir() {
                return Err(if synthesis_only {
                    error
                } else {
                    crate::floorplan::failure(
                        &r.workspace.join("runs/hdlview"),
                        cfg,
                        config["FP_CORE_UTIL"].as_f64(),
                        error,
                    )
                });
            }
            Some(format!("{error:#}"))
        }
    };
    let run = r.workspace.join("runs/hdlview");
    let mut states = Vec::new();
    let mut reports = Vec::new();
    collect_artifacts(&run, &mut states, &mut reports)?;
    states.sort_by_key(|p| {
        p.parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .and_then(|s| s.split('-').next())
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0)
    });
    let statepath = states
        .last()
        .context("LibreLane finished without a state_out.json")?;
    fs::write(
        r.workspace.join("collect_physical.py"),
        include_str!("../../../tools/collect_physical.py"),
    )?;
    r.run(
        "python3",
        &[
            r.workspace
                .join("collect_physical.py")
                .to_string_lossy()
                .into(),
            statepath.to_string_lossy().into(),
            r.workspace
                .join("physical-state.json")
                .to_string_lossy()
                .into(),
        ],
        &r.workspace,
        "collect-physical",
    )?;
    let state: Value = read_json(&r.workspace.join("physical-state.json"))?;
    let mut layout = None;
    let mut gds = None;
    let mut layer_file = None;
    let mut stack_file = None;
    let mut checks = None;
    if !synthesis_only {
        let file = |name: &str| r.workspace.join(name).to_string_lossy().into_owned();
        // The views are extras: a build without them is still a complete build.
        let mut unavailable = |view: &str, error: anyhow::Error| {
            diagnostics.push(Diagnostic {
                severity: "warning".into(),
                message: format!(
                    "{view} unavailable: {}",
                    format!("{error:#}").lines().next().unwrap_or_default()
                ),
                source: None,
            })
        };
        fs::write(
            r.workspace.join("layout_dump.py"),
            include_str!("../../../tools/layout_dump.py"),
        )?;
        let dumped = match state["odb"].as_str() {
            Some(odb) => r.run(
                "openroad",
                &[
                    "-exit".into(),
                    "-no_splash".into(),
                    "-python".into(),
                    file("layout_dump.py"),
                    odb.into(),
                    file("layout.json"),
                ],
                &r.workspace,
                "layout",
            ),
            None => Err(anyhow::anyhow!("the flow left no database")),
        };
        r.cancel.check()?;
        match dumped {
            Ok(_) => layout = Some(r.workspace.join("layout.json")),
            Err(error) => unavailable("Layout view", error),
        }
        // The layer file lives in the PDK, which a Docker toolchain only has inside
        // the image, so it is copied beside the run for the mask view to read.
        let layers = layer_properties(&r.profile, cfg);
        let copied = r.run(
            "cp",
            &[layers.to_string_lossy().into(), file("layers.lyp")],
            &r.workspace,
            "layer-file",
        );
        r.cancel.check()?;
        match (
            state["gds"].as_str().or(state["klayout_gds"].as_str()),
            copied,
        ) {
            (Some(path), Ok(_)) => {
                gds = Some(path.into());
                layer_file = Some(r.workspace.join("layers.lyp"));
            }
            (None, _) => unavailable("Mask view", anyhow::anyhow!("the flow left no GDS")),
            (_, Err(error)) => unavailable("Mask view", error),
        }
        if gds.is_some() {
            let stack = layer_stack(&r.profile, cfg);
            match r.run(
                "cp",
                &[stack.to_string_lossy().into(), file("stack.lyd25")],
                &r.workspace,
                "stack-file",
            ) {
                Ok(_) => stack_file = Some(r.workspace.join("stack.lyd25")),
                Err(error) => unavailable("3D view", error),
            }
            r.cancel.check()?;
        }
        fs::write(
            r.workspace.join("collect_checks.py"),
            include_str!("../../../tools/collect_checks.py"),
        )?;
        let collected = r.run(
            "python3",
            &[
                file("collect_checks.py"),
                run.to_string_lossy().into(),
                file("physical-state.json"),
                file("checks.json"),
            ],
            &r.workspace,
            "collect-checks",
        );
        r.cancel.check()?;
        match collected {
            Ok(_) => checks = Some(r.workspace.join("checks.json")),
            Err(error) => unavailable("Check results", error),
        }
    }
    Ok(PhysicalRun {
        status: if flow_error.is_some() {
            "failed_checks"
        } else {
            "complete"
        }
        .into(),
        flow_error,
        directory: run,
        state,
        reports,
        layout,
        gds,
        layer_file,
        stack_file,
        checks,
    })
}
fn collect_artifacts(
    dir: &Path,
    states: &mut Vec<PathBuf>,
    reports: &mut Vec<PathBuf>,
) -> Result<()> {
    for entry in fs::read_dir(dir)? {
        let p = entry?.path();
        if p.is_dir() {
            collect_artifacts(&p, states, reports)?;
        } else if p.file_name().is_some_and(|n| n == "state_out.json") {
            states.push(p)
        } else if p.extension().is_some_and(|x| {
            ["rpt", "csv", "html", "xml", "lyrdb"]
                .iter()
                .any(|kind| x == *kind)
        }) {
            reports.push(p)
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_small_design_gets_a_core_that_holds_the_power_straps() {
        let pdn = json!({"PDN_VOFFSET":16.32,"PDN_VWIDTH":1.6,"PDN_VSPACING":1.7,"PDN_HOFFSET":"16.65","PDN_HWIDTH":1.6,"PDN_HSPACING":1.7});
        let fitting = fitting_utilization(90.0, 30.0, &pdn).unwrap();
        let side = (90.0 / (fitting / 100.0)).sqrt();
        assert!(side > 21.55 && side < 40.0, "{side}");
        assert_eq!(fitting_utilization(20_000.0, 30.0, &pdn), None);
        assert_eq!(fitting_utilization(90.0, 30.0, &json!({})), None);
    }
    #[test]
    fn checks_keep_markers_by_rule_lvs_mismatches_and_what_did_not_run() {
        let d = tempfile::tempdir().unwrap();
        let run = d.path().join("run");
        let write = |name: &str, text: &str| {
            let path = run.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        };
        write("resolved.json", r#"{"DESIGN_NAME":"top"}"#);
        write(
            "65-klayout-drc/reports/drc.klayout.lyrdb",
            "<report-database><categories>
             <category><name>m1.2</name><description>m1.2 : min. m1 spacing : 0.14um</description></category>
             <category><name>li.1</name><description>li.1 : min. li width</description></category>
             </categories><items>
             <item><category>'m1.2'</category><values><value>edge-pair: (1.5,2;1.5,3)|(1.6,2.5;1.6,4)</value></values></item>
             <item><category>'m1.2'</category><values><value>polygon: (10,10;10,12;-1e-3,12)</value></values></item>
             <item><category>'li.1'</category><values><value>box: (5,5;6,7)</value></values></item>
             </items></report-database>",
        );
        write(
            "70-netgen-lvs/reports/lvs.netgen.json",
            r#"[{"name":["top","top"],"devices":[[["inv",3],["nand",1]],[["inv",3]]],"nets":[6,5],
                 "badnets":[[[["n1",[["inv","A",1]]]],[["n2",[["inv","A",2]]]]]],
                 "badelements":[[[["inv0",[["A",1]]]],[]]],
                 "pins":[["a","VPWR"],["a","vpwr","b"]]}]"#,
        );
        let state = d.path().join("state.json");
        fs::write(
            &state,
            r#"{"metrics":{"klayout__drc_error__count":3,"design__lvs_error__count":2,"route__drc_errors":0,"antenna__violating__nets":"NaN"}}"#,
        )
        .unwrap();
        let script = d.path().join("collect_checks.py");
        fs::write(&script, include_str!("../../../tools/collect_checks.py")).unwrap();
        let out = d.path().join("checks.json");
        let status = std::process::Command::new("python3")
            .arg(&script)
            .args([&run, &state, &out])
            .status()
            .unwrap();
        assert!(status.success());
        let checks: Value = read_json(&out).unwrap();
        let check = |id: &str| {
            checks["checks"]
                .as_array()
                .unwrap()
                .iter()
                .find(|check| check["id"] == id)
                .unwrap()
                .clone()
        };
        assert_eq!(check("routing_drc")["status"], "clean");
        assert_eq!(check("magic_drc")["status"], "not_run");
        assert_eq!(check("antenna")["status"], "not_run");
        let drc = check("klayout_drc");
        assert_eq!(drc["status"], "violations");
        assert_eq!(drc["count"], 3);
        assert_eq!(
            drc["rules"],
            json!([
                {"rule":"m1.2","description":"m1.2 : min. m1 spacing : 0.14um","count":2,
                 "boxes":[[1.5,2.0,1.6,4.0],[-0.001,10.0,10.0,12.0]]},
                {"rule":"li.1","description":"li.1 : min. li width","count":1,"boxes":[[5.0,5.0,6.0,7.0]]}
            ])
        );
        let lvs = check("lvs");
        assert_eq!(lvs["status"], "violations");
        assert_eq!(lvs["summary"], json!({"devices":[4,3],"nets":[6,5]}));
        assert_eq!(
            lvs["mismatches"],
            json!([
                {"kind":"net","cell":"top","layout":["n1"],"netlist":["n2"]},
                {"kind":"device","cell":"top","layout":["inv0"],"netlist":[]},
                {"kind":"pin","cell":"top","layout":[],"netlist":["b"]}
            ])
        );
    }
    #[test]
    fn several_clocks_are_each_constrained_and_asynchronous_unless_related() {
        let clocks = [("wr_clk", 10.0), ("rd_clk", 12.5)];
        let sdc = clocks_sdc(&clocks, false);
        for statement in [
            "create_clock [get_ports {wr_clk}] -name {wr_clk} -period 10\n",
            "create_clock [get_ports {rd_clk}] -name {rd_clk} -period 12.5\n",
            "set_clock_groups -asynchronous -group {wr_clk} -group {rd_clk}\n",
            "set clock_ports [get_ports {wr_clk rd_clk}]\n",
            "set_input_delay $io_delay -clock [get_clocks {rd_clk}] -add_delay $data_inputs\n",
            "set_output_delay $io_delay -clock [get_clocks {wr_clk}] -add_delay [all_outputs]\n",
        ] {
            assert!(sdc.contains(statement), "{statement}");
        }
        assert!(!clocks_sdc(&clocks, true).contains("set_clock_groups"));
    }
}
