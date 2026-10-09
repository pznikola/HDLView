use crate::{
    model::*,
    pipeline::{diagnostics_from_log, model_files},
    project::*,
    runner::*,
    waveform,
};
use anyhow::{bail, Context, Result};
use std::{collections::BTreeMap, fs, path::PathBuf};

fn duration(s: &str) -> Result<&str> {
    crate::settings::duration(s)?;
    Ok(s)
}
fn verilog_string(s: &str) -> String {
    format!(
        "\"{}\"",
        s.replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
    )
}
pub fn simulate(
    snapshot: &DesignSnapshot,
    name: &str,
    cancel: CancelToken,
) -> Result<SimulationRun> {
    validate_captured(&snapshot.project)?;
    let cfg = snapshot
        .project
        .simulations
        .get(name)
        .with_context(|| format!("Unknown simulation configuration {name}"))?;
    duration(&cfg.stop_time)?;
    if cfg
        .delay_selection
        .as_ref()
        .is_some_and(|s| !["min", "typ", "max"].contains(&s.as_str()))
    {
        bail!("delay_selection must be min, typ or max")
    }
    identifier(&cfg.top)?;
    for p in &cfg.dut_scope {
        identifier(p)?;
    }
    let gate = snapshot.representation.is_gate();
    for file in &cfg.testbench {
        validate_hdl(file, false)?;
    }
    let sdf = if cfg.use_snapshot_sdf {
        if !gate {
            bail!("SDF is only valid for gate snapshots")
        }
        if let Some(corner) = &cfg.timing_corner {
            Some(
                snapshot
                    .sdf
                    .get(corner)
                    .context("Snapshot has no SDF for this corner")?
                    .clone(),
            )
        } else if snapshot.sdf.len() == 1 {
            snapshot.sdf.values().next().cloned()
        } else {
            bail!("Choose timing_corner from the snapshot SDF corners")
        }
    } else {
        cfg.sdf
            .as_ref()
            .map(|p| snapshot.directory.join("inputs").join(p))
    };
    if sdf.is_some() && (!gate || cfg.simulator != Simulator::Icarus) {
        bail!("SDF runs require a gate snapshot and Icarus")
    }
    let dir = unique_dir(&snapshot.directory.join("simulations"), name)?;
    let r = Runner::new(snapshot.profile.clone(), snapshot.directory.clone(), cancel);
    let inputs = snapshot.directory.join("inputs");
    let trace = dir.join("trace.vcd");
    let mut files = if gate {
        vec![snapshot
            .netlist
            .clone()
            .context("Gate snapshot lacks simulation netlist")?]
    } else {
        snapshot
            .project
            .sources
            .iter()
            .map(|s| inputs.join(&s.path))
            .collect()
    };
    files.extend(cfg.testbench.iter().map(|p| inputs.join(p)));
    let mut models = cfg
        .models
        .iter()
        .map(|p| inputs.join(p))
        .collect::<Vec<_>>();
    if !gate {
        models.clear();
    }
    if gate && models.is_empty() {
        if let Some(p) = &snapshot.project.physical {
            models = model_files(&snapshot.profile, p)?;
        }
    }
    files.extend(models.clone());
    let mut defines = snapshot.project.defines.clone();
    defines.extend(cfg.defines.clone());
    if gate
        && sdf.is_none()
        && snapshot
            .project
            .physical
            .as_ref()
            .is_some_and(|p| p.pdk == "sky130A")
    {
        defines.insert("FUNCTIONAL".into(), "1".into());
    }
    let mut diagnostics = Vec::new();
    let mut dut_scope = cfg.dut_scope.clone();
    let log = {
        // A generated top wraps the user's testbench without changing its source.
        if cfg.dut_scope.first() != Some(&cfg.top) {
            bail!("DUT scope must begin with the testbench top")
        }
        let target = cfg.dut_scope.join(".");
        dut_scope.insert(0, "hdlview_sim".into());
        let specialization = if gate {
            String::new()
        } else {
            rtl_parameter_overrides(&snapshot.project, cfg)?
        };
        let annotation = sdf
            .as_ref()
            .map(|p| {
                format!(
                    "$sdf_annotate({}, {target});",
                    verilog_string(&p.to_string_lossy())
                )
            })
            .unwrap_or_default();
        let harness=format!("`timescale 1ns/1ps\nmodule hdlview_sim;\n  {} {}();\n{specialization}  initial begin\n    $dumpfile({});\n    $dumpvars(0, {});\n    {}\n    #({}) $finish;\n  end\nendmodule\n",cfg.top,cfg.top,verilog_string(&trace.to_string_lossy()),target,annotation,cfg.stop_time);
        let harnesspath = dir.join("hdlview_sim.sv");
        fs::write(&harnesspath, harness)?;
        files.push(harnesspath);
        let mut incargs = Vec::new();
        for d in &snapshot.project.include_dirs {
            incargs.push(format!("-I{}", inputs.join(d).display()));
        }
        for m in &models {
            if let Some(d) = m.parent() {
                incargs.push(format!("-I{}", d.display()));
            }
        }
        for (k, v) in &defines {
            identifier(k)?;
            incargs.push(format!("-D{k}={v}"));
        }
        if cfg.simulator == Simulator::Icarus {
            let mut args = vec![
                "-g2012".into(),
                "-s".into(),
                "hdlview_sim".into(),
                "-o".into(),
                dir.join("sim.vvp").to_string_lossy().into(),
            ];
            if sdf.is_some() {
                args.extend(["-gspecify".into(), "-ginterconnect".into()]);
                let corner = cfg
                    .delay_selection
                    .as_deref()
                    .unwrap_or(if cfg.use_snapshot_sdf { "max" } else { "typ" });
                if ["min", "typ", "max"].contains(&corner) {
                    args.push(format!("-T{corner}"));
                }
            }
            args.extend(incargs);
            args.extend(files.iter().map(|p| p.to_string_lossy().into_owned()));
            let compile = r.run("iverilog", &args, &dir, "iverilog-compile")?;
            diagnostics.extend(diagnostics_from_log(&compile));
            let mut args = vec![dir.join("sim.vvp").to_string_lossy().into_owned()];
            if sdf.is_some() {
                args.push("-sdf-verbose".into());
            }
            args.extend(cfg.args.clone());
            r.run("vvp", &args, &dir, "icarus-simulate")?
        } else {
            let mut args = vec![
                "--binary".into(),
                "--timing".into(),
                "--trace".into(),
                "--trace-structs".into(),
                "--top-module".into(),
                "hdlview_sim".into(),
                "--Mdir".into(),
                dir.join("obj").to_string_lossy().into(),
                "-Wno-fatal".into(),
            ];
            args.extend(incargs);
            args.extend(files.iter().map(|p| p.to_string_lossy().into_owned()));
            let log = r.run("verilator", &args, &dir, "verilator-compile")?;
            diagnostics.extend(diagnostics_from_log(&log));
            r.run(
                &dir.join("obj/Vhdlview_sim").to_string_lossy(),
                &cfg.args,
                &dir,
                "verilator-simulate",
            )?
        }
    };
    diagnostics.extend(diagnostics_from_log(&log));
    if log.lines().any(|l| {
        l.contains("SDF ERROR")
            || l.contains("Unable to match")
            || l.contains("Unable to find")
            || l.contains("Unable to open SDF")
    }) {
        bail!("SDF annotation failed; inspect simulation logs")
    }
    if sdf.is_some() {
        diagnostics.push(Diagnostic{severity:"warning".into(),message:"Icarus SDF delay simulation: complete timing-check coverage is not supported. Consult annotation diagnostics and STA reports.".into(),source:None});
    }
    let trace = collect_trace(&dir, &trace, &dut_scope, &r.cancel)?;
    let trace_hash = file_hash(&trace)?;
    let mut manifest = json_manifest(snapshot, cfg, &files, &models, &sdf)?;
    manifest["trace"] =
        serde_json::json!({"path": trace, "hash": trace_hash, "dut_scope": dut_scope});
    if trace.file_name().is_some_and(|name| name != "trace.vcd") {
        diagnostics.push(Diagnostic {
            severity: "info".into(),
            message: format!("Using testbench-generated waveform {}", trace.display()),
            source: None,
        });
    }
    atomic_json(&dir.join("manifest.json"), &manifest)?;
    let id = hash(serde_json::to_vec(&(
        snapshot.id.clone(),
        cfg,
        trace_hash.clone(),
    ))?);
    let run = SimulationRun {
        schema_version: SCHEMA,
        id,
        snapshot_id: snapshot.id.clone(),
        representation: snapshot.representation.clone(),
        trace,
        trace_hash,
        dut_scope,
        simulator: Some(cfg.simulator.clone()),
        diagnostics,
        directory: dir.clone(),
        imported: false,
    };
    atomic_json(&dir.join("run.json"), &run)?;
    Ok(run)
}
fn collect_trace(
    dir: &std::path::Path,
    expected: &std::path::Path,
    dut: &[String],
    cancel: &CancelToken,
) -> Result<PathBuf> {
    cancel.check()?;
    let root = fs::canonicalize(dir)?;
    fn validate(path: &std::path::Path, root: &std::path::Path, dut: &[String]) -> Result<()> {
        if !fs::symlink_metadata(path)?.is_file() {
            bail!(
                "Waveform must be a regular file (no symlinks): {}",
                path.display()
            )
        }
        if !fs::canonicalize(path)?.starts_with(root) {
            bail!(
                "Waveform path is outside the simulation directory: {}",
                path.display()
            )
        }
        if !waveform::contains_dut(path, dut)
            .with_context(|| format!("Malformed waveform {}", path.display()))?
        {
            bail!(
                "Waveform {} has no variables under DUT scope {}",
                path.display(),
                dut.join(".")
            )
        }
        Ok(())
    }
    if expected.try_exists()? {
        validate(expected, &root, dut)?;
        return Ok(expected.to_path_buf());
    }
    let mut pending = vec![root.clone()];
    let mut candidates = Vec::new();
    let mut failures = Vec::new();
    while let Some(directory) = pending.pop() {
        cancel.check()?;
        for entry in fs::read_dir(&directory)? {
            cancel.check()?;
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                pending.push(entry.path());
            } else if kind.is_file()
                && entry
                    .path()
                    .extension()
                    .and_then(|s| s.to_str())
                    .is_some_and(|s| s.eq_ignore_ascii_case("vcd") || s.eq_ignore_ascii_case("fst"))
            {
                match validate(&entry.path(), &root, dut) {
                    Ok(()) => candidates.push(entry.path()),
                    Err(error) => failures.push(error.to_string()),
                }
            }
        }
    }
    candidates.sort();
    match candidates.as_slice() {
        [trace] => Ok(trace.clone()),
        [] => bail!(
            "Simulator produced no usable waveform under {} for DUT {}. Expected {}. {}",
            dir.display(),
            dut.join("."),
            expected.display(),
            failures.join("; ")
        ),
        _ => bail!(
            "Multiple waveforms contain DUT {}: {}. Import the intended waveform explicitly.",
            dut.join("."),
            candidates
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}
fn json_manifest(
    s: &DesignSnapshot,
    c: &SimulationConfig,
    files: &[PathBuf],
    models: &[PathBuf],
    sdf: &Option<PathBuf>,
) -> Result<serde_json::Value> {
    let mut hashes = BTreeMap::new();
    for p in files.iter().chain(sdf.iter()) {
        if p.is_file() {
            hashes.insert(p.to_string_lossy().into_owned(), file_hash(p)?);
        }
    }
    Ok(
        serde_json::json!({"snapshot":s.id,"effective_delay_selection":c.delay_selection.as_deref().unwrap_or(if c.use_snapshot_sdf{"max"}else{"typ"}),"configuration":c,"files":files,"model_files":models,"sdf":sdf,"host_visible_file_hashes":hashes,"toolchain":s.profile,"tool_versions":s.tool_versions}),
    )
}

/// Match the RTL simulator's specialization at the DUT instance, not the testbench top.
pub(crate) fn rtl_parameter_overrides(
    project: &ProjectConfig,
    config: &SimulationConfig,
) -> Result<String> {
    if config.dut_scope.first() != Some(&config.top) {
        bail!("DUT scope must begin with the testbench top")
    }
    let target = config.dut_scope.join(".");
    let mut overrides = String::new();
    for (key, value) in &project.parameters {
        if value.contains([';', '\n', '\r']) {
            bail!("Invalid parameter expression")
        }
        overrides.push_str(&format!("defparam {target}.{key} = {value};\n"));
    }
    Ok(overrides)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn trace(path: &std::path::Path, scope: &str) {
        fs::write(path, format!("$timescale 1 ns $end\n$scope module tb $end\n$scope module {scope} $end\n$var wire 1 ! data $end\n$upscope $end\n$upscope $end\n$enddefinitions $end\n#0\n0!\n#10\n1!\n")).unwrap();
    }
    #[test]
    fn collects_only_unambiguous_current_run_traces() {
        let dir = tempfile::tempdir().unwrap();
        let expected = dir.path().join("trace.vcd");
        let alternative = dir.path().join("testbench.vcd");
        let scope = vec!["tb".into(), "dut".into()];
        let cancel = CancelToken::default();
        trace(&alternative, "dut");
        trace(&dir.path().join("wrong.vcd"), "other");
        assert_eq!(
            collect_trace(dir.path(), &expected, &scope, &cancel).unwrap(),
            alternative
        );
        let nested = dir.path().join("waves");
        fs::create_dir(&nested).unwrap();
        trace(&nested.join("duplicate.vcd"), "dut");
        assert!(collect_trace(dir.path(), &expected, &scope, &cancel)
            .unwrap_err()
            .to_string()
            .contains("Multiple waveforms"));
        trace(&expected, "dut");
        assert_eq!(
            collect_trace(dir.path(), &expected, &scope, &cancel).unwrap(),
            expected
        );
        fs::write(&expected, "invalid VCD").unwrap();
        assert!(collect_trace(dir.path(), &expected, &scope, &cancel)
            .unwrap_err()
            .to_string()
            .contains("Malformed waveform"));
    }
    #[test]
    fn missing_wrong_scope_symlinks_and_cancellation_fail_safely() {
        let dir = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let expected = dir.path().join("trace.vcd");
        let scope = vec!["tb".into(), "dut".into()];
        let cancel = CancelToken::default();
        trace(&external.path().join("outside.vcd"), "dut");
        std::os::unix::fs::symlink(
            external.path().join("outside.vcd"),
            dir.path().join("link.vcd"),
        )
        .unwrap();
        std::os::unix::fs::symlink(external.path(), dir.path().join("external")).unwrap();
        assert!(collect_trace(dir.path(), &expected, &scope, &cancel).is_err());
        fs::create_dir(&expected).unwrap();
        assert!(collect_trace(dir.path(), &expected, &scope, &cancel)
            .unwrap_err()
            .to_string()
            .contains("regular file"));
        fs::remove_dir(&expected).unwrap();
        trace(&expected, "other");
        assert!(collect_trace(dir.path(), &expected, &scope, &cancel)
            .unwrap_err()
            .to_string()
            .contains("DUT scope"));
        cancel.cancel();
        assert!(collect_trace(dir.path(), &expected, &scope, &cancel)
            .unwrap_err()
            .to_string()
            .contains("cancelled"));
    }
    #[test]
    fn sdf_restrictions_fail_before_creating_a_job_directory() {
        let d = tempfile::tempdir().unwrap();
        let mut snapshot: DesignSnapshot = serde_json::from_value(serde_json::json!({
            "schema_version":SCHEMA,"id":"sdf","representation":"elaborated","directory":d.path(),
            "project":{"schema_version":3,"name":"SDF","top":"top","sources":[],
                "simulations":{"shared":{"simulator":"icarus","top":"tb","dut_scope":["tb","dut"],"testbench":[],"sdf":"delay.sdf"}}},
            "profile":ToolchainProfile::default(),"design":{"modules":{},"scopes":[]},
            "diagnostics":[],"tool_versions":{},"input_hashes":{},"artifact_hashes":{},"source_origins":{},"netlist":null,"sdf":{}
        })).unwrap();
        assert!(simulate(&snapshot, "shared", CancelToken::default())
            .unwrap_err()
            .to_string()
            .contains("gate snapshot"));
        snapshot.representation = Representation::Mapped;
        snapshot
            .project
            .simulations
            .get_mut("shared")
            .unwrap()
            .simulator = Simulator::Verilator;
        assert!(simulate(&snapshot, "shared", CancelToken::default())
            .unwrap_err()
            .to_string()
            .contains("Icarus"));
        assert!(!d.path().join("simulations").exists());
    }
    #[test]
    fn validate_duration() {
        assert!(duration("100ns").is_ok());
        assert!(duration("1); $finish;").is_err());
        assert!(duration("0ns").is_err());
    }
}
