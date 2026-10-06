use crate::{graph, model::*, project::*, runner::*};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

fn q(path: &Path) -> Result<String> {
    yosys_quote(&path.to_string_lossy())
}
fn plugin(r: &Runner, name: &str, command: &str) -> Result<Vec<String>> {
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
    if !help.contains("No such command") {
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
pub fn yosys(r: &Runner, script: &str, plugins: Vec<String>, label: &str) -> Result<String> {
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
pub fn frontend(r: &Runner, p: &ProjectConfig) -> Result<(String, Vec<String>)> {
    let inputs = r.workspace.join("inputs");
    let mut script = String::new();
    let plugins = if p.sources[0].language == Language::Vhdl {
        for s in &p.sources {
            let a = vec![
                "-a".into(),
                format!("--std={}", p.standard),
                format!("--work={}", s.library.as_deref().unwrap_or("work")),
                inputs.join(&s.path).to_string_lossy().into(),
            ];
            r.run("ghdl", &a, &r.workspace, "ghdl-analyze")?;
        }
        script.push_str(&format!("ghdl --std={} ", identifier(&p.standard)?));
        for (k, v) in &p.parameters {
            script.push_str(&format!("{} ", yosys_quote(&format!("-g{k}={v}"))?));
        }
        script.push_str(&format!("{}\n", identifier(&p.top)?));
        plugin(r, "ghdl", "ghdl")?
    } else {
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
    let profile = resolve_profile(profile)?;
    let project = load_project(project_path)?;
    let resuming = resume.is_some();
    let dir = match resume {
        Some(path) => path,
        None => unique_dir(store, "design")?,
    };
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
        capture(project_path, &project, &dir)?
    };
    atomic_json(&dir.join("toolchain.json"), &profile)?;
    let runner = Runner::new(profile.clone(), dir.clone(), cancel);
    let tool_versions = runner.probe();
    runner.cancel.check()?;
    // Docker's immutable image covers compiler/plugin/model contents. External
    // native installations and mounted PDKs are conservatively rebuilt.
    let cache_key = if !resuming
        && matches!(profile.provider, Provider::Docker)
        && !profile.pdk_root.as_ref().is_some_and(|p| p.exists())
    {
        Some(hash(serde_json::to_vec(
            &json!({"project":project,"profile":profile,"representation":representation,"inputs":inputs,"tools":tool_versions,"application":file_hash(&std::env::current_exe()?)?}),
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
    let design = if representation == Representation::Source {
        fs::write(
            dir.join("source_graph.py"),
            include_str!("../../../tools/source_graph.py"),
        )?;
        runner.run(
            "python3",
            &[
                dir.join("source_graph.py").to_string_lossy().into(),
                dir.join("project.json").to_string_lossy().into(),
                dir.join("inputs").to_string_lossy().into(),
                dir.join("source.json").to_string_lossy().into(),
            ],
            &dir,
            "source",
        )?;
        let result: Value = read_json(&dir.join("source.json"))?;
        let mut d: Design = serde_json::from_value(result["design"].clone())?;
        graph::build_scopes(&mut d, &project.top)?;
        diagnostics.extend(serde_json::from_value::<Vec<Diagnostic>>(
            result["diagnostics"].clone(),
        )?);
        d
    } else {
        if !resuming {
            let (mut script, plugins) = frontend(&runner, &project)?;
            script.push_str("write_rtlil elaborated.il\nwrite_json elaborated.json\nwrite_verilog -noattr normalized.v\n");
            let log = yosys(&runner, &script, plugins, "elaborate")?;
            diagnostics.extend(diagnostics_from_log(&log));
        }
        match representation {
            Representation::Elaborated => {
                graph::from_yosys(&read_json(&dir.join("elaborated.json"))?, &project.top)?
            }
            Representation::Generic => {
                let script=format!("read_rtlil elaborated.il\nsynth -top {}\nwrite_verilog -noattr -noexpr -norename netlist.v\nwrite_json generic.json\n",project.top);
                diagnostics.extend(diagnostics_from_log(&yosys(
                    &runner,
                    &script,
                    vec![],
                    "synthesize",
                )?));
                netlist = Some(dir.join("netlist.v"));
                // Re-import the exact simulation file with Yosys generic gate definitions.
                yosys(&runner,"read_verilog -lib +/simcells.v\nread_verilog netlist.v\nhierarchy -check -top ".to_owned().add(&project.top).add("\nwrite_json graph.json\n").as_str(),vec![],"import-generic")?;
                graph::from_yosys(&read_json(&dir.join("graph.json"))?, &project.top)?
            }
            Representation::Mapped | Representation::PostLayout => {
                let physical =
                    run_physical(&runner, &project, representation == Representation::Mapped)?;
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
                graph::from_yosys(&read_json(&dir.join("graph.json"))?, &project.top)?
            }
            _ => unreachable!(),
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
    let snapshot = DesignSnapshot {
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
use std::ops::Add;

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
pub fn library_files(profile: &ToolchainProfile, p: &PhysicalConfig) -> Result<Vec<PathBuf>> {
    let root = profile
        .pdk_root
        .clone()
        .unwrap_or_else(|| "/foss/pdks".into());
    let lib=match(p.pdk.as_str(),p.library.as_str()) {
  ("sky130A","sky130_fd_sc_hd")=>root.join("sky130A/libs.ref/sky130_fd_sc_hd/lib/sky130_fd_sc_hd__tt_025C_1v80.lib"),
  ("ihp-sg13g2","sg13g2_stdcell")=>root.join("ihp-sg13g2/libs.ref/sg13g2_stdcell/lib/sg13g2_stdcell_typ_1p20V_25C.lib"),
  _=>bail!("Unsupported PDK/library preset; use sky130A/sky130_fd_sc_hd or ihp-sg13g2/sg13g2_stdcell"),
 };
    Ok(vec![lib])
}
pub fn model_files(profile: &ToolchainProfile, p: &PhysicalConfig) -> Result<Vec<PathBuf>> {
    let root = profile
        .pdk_root
        .clone()
        .unwrap_or_else(|| "/foss/pdks".into());
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
fn run_physical(r: &Runner, p: &ProjectConfig, synthesis_only: bool) -> Result<PhysicalRun> {
    let cfg = p
        .physical
        .as_ref()
        .context("A physical configuration is required for mapped/post-layout builds")?;
    identifier(&cfg.clock_port)?;
    if !cfg.clock_period_ns.is_finite() || cfg.clock_period_ns <= 0.0 {
        bail!("Clock period must be positive")
    }
    library_files(&r.profile, cfg)?;
    let mut config = serde_json::Map::new();
    config.insert("DESIGN_NAME".into(), json!(p.top));
    config.insert(
        "VERILOG_FILES".into(),
        json!([r.workspace.join("normalized.v")]),
    );
    config.insert("CLOCK_PORT".into(), json!(cfg.clock_port));
    config.insert("CLOCK_PERIOD".into(), json!(cfg.clock_period_ns));
    config.insert("FP_CORE_UTIL".into(), json!(30));
    config.insert("PL_TARGET_DENSITY_PCT".into(), json!(40));
    if let Some(sdc) = &cfg.sdc {
        config.insert(
            "PNR_SDC_FILE".into(),
            json!(r.workspace.join("inputs").join(sdc)),
        );
        config.insert(
            "SIGNOFF_SDC_FILE".into(),
            json!(r.workspace.join("inputs").join(sdc)),
        );
    }
    for (k, v) in &cfg.overrides {
        if ["DESIGN_NAME", "VERILOG_FILES", "PDK", "STD_CELL_LIBRARY"].contains(&k.as_str()) {
            bail!("Reserved physical configuration key {k}")
        }
        config.insert(k.clone(), v.clone());
    }
    let configpath = r.workspace.join("librelane.json");
    atomic_json(&configpath, &config)?;
    let mut args = vec![
        "--manual-pdk".into(),
        "--pdk-root".into(),
        r.profile
            .pdk_root
            .clone()
            .unwrap_or_else(|| "/foss/pdks".into())
            .to_string_lossy()
            .into(),
        "--pdk".into(),
        cfg.pdk.clone(),
        "--scl".into(),
        cfg.library.clone(),
        "--flow".into(),
        "Classic".into(),
        "--run-tag".into(),
        "hdlview".into(),
    ];
    if synthesis_only {
        args.extend(["--to".into(), "Yosys.Synthesis".into()]);
    }
    args.push(configpath.to_string_lossy().into());
    let outcome = if r.workspace.join("runs/hdlview/final/nl").is_dir() {
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
                return Err(error);
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
        } else if p
            .extension()
            .is_some_and(|x| x == "rpt" || x == "csv" || x == "html" || x == "xml")
        {
            reports.push(p)
        }
    }
    Ok(())
}
