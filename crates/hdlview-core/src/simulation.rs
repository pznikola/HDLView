use crate::{
    model::*,
    pipeline::{diagnostics_from_log, model_files},
    project::*,
    runner::*,
};
use anyhow::{bail, Context, Result};
use std::{collections::BTreeMap, fs, path::PathBuf};

fn duration(s: &str) -> Result<&str> {
    let split = s
        .find(|c: char| !c.is_ascii_digit())
        .context("Stop time needs an integer and unit, e.g. 100ns")?;
    let (n, u) = s.split_at(split);
    if n.parse::<u64>()? == 0 || !["s", "ms", "us", "ns", "ps", "fs"].contains(&u) {
        bail!("Invalid stop time {s}")
    }
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
        .map(|p| {
            if p.path().is_absolute() {
                p.path().to_path_buf()
            } else {
                inputs.join(p)
            }
        })
        .collect::<Vec<_>>();
    if !gate {
        models.clear();
    }
    if gate && models.is_empty() {
        if let Some(p) = &snapshot.project.physical {
            if snapshot.representation != Representation::Generic {
                models = model_files(&snapshot.profile, p)?;
            }
        }
    }
    if gate && snapshot.representation == Representation::Generic {
        let data = r.run("yosys-config", &["--datdir".into()], &dir, "yosys-data")?;
        models.push(PathBuf::from(data.trim()).join("simcells.v"));
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
    let log = match cfg.simulator {
        Simulator::Icarus | Simulator::Verilator => {
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
    if !trace.exists() {
        bail!("Simulator completed without producing {}", trace.display())
    }
    let trace_hash = file_hash(&trace)?;
    let manifest = json_manifest(snapshot, cfg, &files, &models, &sdf)?;
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
    #[test]
    fn sdf_restrictions_fail_before_creating_a_job_directory() {
        let d = tempfile::tempdir().unwrap();
        let mut snapshot: DesignSnapshot = serde_json::from_value(serde_json::json!({
            "schema_version":SCHEMA,"id":"sdf","representation":"elaborated","directory":d.path(),
            "project":{"schema_version":3,"name":"SDF","top":"top","sources":[],
                "simulations":{"shared":{"simulator":"icarus","top":"tb","dut_scope":["tb","dut"],"testbench":[],"sdf":"delay.sdf"}}},
            "profile":ToolchainProfile::default(),"design":{"modules":{},"scopes":[]},
            "diagnostics":[],"tool_versions":{},"input_hashes":{},"netlist":null
        })).unwrap();
        assert!(simulate(&snapshot, "shared", CancelToken::default())
            .unwrap_err()
            .to_string()
            .contains("gate snapshot"));
        snapshot.representation = Representation::Generic;
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
