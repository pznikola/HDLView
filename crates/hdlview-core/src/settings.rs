use crate::{model::*, project::*, runner::identifier, workspace};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Deserialize)]
pub struct SettingsIssue {
    pub field: String,
    pub message: String,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct SettingsValidation {
    pub errors: Vec<SettingsIssue>,
    pub warnings: Vec<SettingsIssue>,
    pub matches_snapshot: Option<bool>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SettingsInputKind {
    IncludeDirectory,
    Model,
    Sdc,
    Sdf,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SettingsInputs {
    pub project: ProjectConfig,
    pub kind: SettingsInputKind,
    pub paths: Vec<PathBuf>,
}
#[derive(Debug, Serialize)]
pub struct SettingsReferences {
    pub project: ProjectConfig,
    pub references: Vec<FileRef>,
}

pub(crate) fn duration(s: &str) -> Result<()> {
    let split = s
        .find(|c: char| !c.is_ascii_digit())
        .context("Duration needs a positive integer and unit, e.g. 100ns")?;
    let (number, unit) = s.split_at(split);
    if number
        .parse::<u64>()
        .context("Duration needs a positive integer")?
        == 0
        || !["s", "ms", "us", "ns", "ps", "fs"].contains(&unit)
    {
        bail!("Duration needs a positive integer and s, ms, us, ns, ps or fs")
    }
    Ok(())
}

// These field checks are shared by project updates/saves and settings feedback.
pub(crate) fn field_errors(p: &ProjectConfig) -> Vec<SettingsIssue> {
    let mut issues = Vec::new();
    let mut check = |field: String, result: Result<()>| {
        if let Err(error) = result {
            issues.push(SettingsIssue {
                field,
                message: format!("{error:#}"),
            });
        }
    };
    if p.name.trim().is_empty() {
        check(
            "name".into(),
            Err(anyhow::anyhow!("Project name is required")),
        );
    }
    if !p.top.is_empty() {
        check("top".into(), identifier(&p.top).map(|_| ()));
    }
    if ![
        "1364-1995",
        "1364-2001",
        "1364-2005",
        "1800-2005",
        "1800-2009",
        "1800-2012",
        "1800-2017",
        "1800-2023",
    ]
    .contains(&p.standard.as_str())
    {
        check(
            "standard".into(),
            Err(anyhow::anyhow!(
                "Choose a supported Verilog or SystemVerilog language standard"
            )),
        );
    }
    for (field, values) in [("defines", &p.defines), ("parameters", &p.parameters)] {
        for key in values.keys() {
            check(format!("{field}.{key}"), identifier(key).map(|_| ()));
        }
    }
    for (name, s) in &p.simulations {
        let prefix = format!("simulations.{name}");
        if name.trim().is_empty() {
            check(
                "simulations".into(),
                Err(anyhow::anyhow!("Configuration name is required")),
            );
        }
        check(format!("{prefix}.top"), identifier(&s.top).map(|_| ()));
        check(format!("{prefix}.stop_time"), duration(&s.stop_time));
        if s.dut_scope.is_empty() || s.dut_scope.first() != Some(&s.top) {
            check(
                format!("{prefix}.dut_scope"),
                Err(anyhow::anyhow!(
                    "DUT instance path must begin with the testbench top"
                )),
            );
        }
        for segment in &s.dut_scope {
            check(
                format!("{prefix}.dut_scope"),
                identifier(segment).map(|_| ()),
            );
        }
        for key in s.defines.keys() {
            check(
                format!("{prefix}.defines.{key}"),
                identifier(key).map(|_| ()),
            );
        }
        if s.delay_selection
            .as_ref()
            .is_some_and(|value| !["min", "typ", "max"].contains(&value.as_str()))
        {
            check(
                format!("{prefix}.delay_selection"),
                Err(anyhow::anyhow!("Choose min, typ or max")),
            );
        }
        if (s.sdf.is_some() || s.use_snapshot_sdf) && s.simulator != Simulator::Icarus {
            check(
                format!("{prefix}.simulator"),
                Err(anyhow::anyhow!("SDF simulation requires Icarus")),
            );
        }
        if s.sdf.is_some() && s.use_snapshot_sdf {
            check(
                format!("{prefix}.sdf"),
                Err(anyhow::anyhow!("Choose either external or snapshot SDF")),
            );
        }
        if s.sdf
            .as_ref()
            .is_some_and(|reference| reference.path().as_os_str().is_empty())
        {
            check(
                format!("{prefix}.sdf"),
                Err(anyhow::anyhow!("Choose an external SDF file")),
            );
        }
    }
    if let Some(physical) = &p.physical {
        check(
            "physical.clock_port".into(),
            identifier(&physical.clock_port).map(|_| ()),
        );
        if !physical.clock_period_ns.is_finite() || physical.clock_period_ns <= 0.0 {
            check(
                "physical.clock_period_ns".into(),
                Err(anyhow::anyhow!("Clock period must be positive")),
            );
        }
        for key in physical.overrides.keys() {
            if ["DESIGN_NAME", "VERILOG_FILES", "PDK", "STD_CELL_LIBRARY"].contains(&key.as_str()) {
                check(
                    "physical.overrides".into(),
                    Err(anyhow::anyhow!("Reserved physical configuration key {key}")),
                );
            }
        }
        for key in ["FP_CORE_UTIL", "PL_TARGET_DENSITY_PCT"] {
            if physical
                .overrides
                .get(key)
                .and_then(|v| v.as_f64())
                .is_some_and(|value| value <= 0.0 || value > 100.0)
            {
                check(
                    format!("physical.{key}"),
                    Err(anyhow::anyhow!(
                        "Percentage must be greater than 0 and at most 100"
                    )),
                );
            }
        }
    }
    issues
}

pub fn validate(path: &Path, p: &ProjectConfig) -> SettingsValidation {
    let mut errors = field_errors(p);
    if errors.is_empty() {
        if let Err(error) = validate_project(p) {
            errors.push(SettingsIssue {
                field: "project".into(),
                message: format!("{error:#}"),
            });
        }
    }
    let mut warnings = Vec::new();
    let mut warn = |field: String, message: String| warnings.push(SettingsIssue { field, message });
    if p.top.is_empty() {
        warn("top".into(), "Set the design top before building".into());
    }
    if p.sources.is_empty() {
        warn(
            "sources".into(),
            "Add design sources before building".into(),
        );
    }
    if p.physical.is_none() {
        warn(
            "physical".into(),
            "Configure a clock port and period before mapped or physical builds".into(),
        );
    }
    if p.simulations.is_empty() {
        warn(
            "simulations".into(),
            "Add a simulation configuration before running simulation".into(),
        );
    }
    for source in &p.sources {
        if let Err(error) = resolve_reference(path, p, &source.path) {
            warn(
                "sources".into(),
                format!("{}: {error:#}", source.path.path().display()),
            );
        }
    }
    for (field, references) in [
        ("include_dirs", p.include_dirs.as_slice()),
        ("headers", p.headers.as_slice()),
        ("simulation_headers", p.simulation_headers.as_slice()),
    ] {
        for reference in references {
            if let Err(error) = resolve_reference(path, p, reference) {
                warn(
                    field.into(),
                    format!("{}: {error:#}", reference.path().display()),
                );
            }
        }
    }
    if let Some(sdc) = p.physical.as_ref().and_then(|f| f.sdc.as_ref()) {
        if let Err(error) = resolve_reference(path, p, sdc) {
            warn(
                "physical.sdc".into(),
                format!("{}: {error:#}", sdc.path().display()),
            );
        }
    }
    for (name, simulation) in &p.simulations {
        if simulation.testbench.is_empty() {
            warn(
                format!("simulations.{name}.testbench"),
                "Select testbench files before running simulation".into(),
            );
        }
        for (field, references) in [
            ("testbench", simulation.testbench.as_slice()),
            ("models", simulation.models.as_slice()),
        ] {
            for reference in references {
                if let Err(error) = resolve_reference(path, p, reference) {
                    warn(
                        format!("simulations.{name}.{field}"),
                        format!("{}: {error:#}", reference.path().display()),
                    );
                }
            }
        }
        if let Some(sdf) = &simulation.sdf {
            if let Err(error) = resolve_reference(path, p, sdf) {
                warn(
                    format!("simulations.{name}.sdf"),
                    format!("{}: {error:#}", sdf.path().display()),
                );
            }
        }
    }
    SettingsValidation {
        errors,
        warnings,
        matches_snapshot: None,
    }
}

/// Resolve picker results against a draft without publishing roots or touching files.
pub fn references(config_path: &Path, request: SettingsInputs) -> Result<SettingsReferences> {
    let mut project = workspace::prepare_saved_config(config_path, &request.project)?;
    let mut references = Vec::new();
    if matches!(
        request.kind,
        SettingsInputKind::Sdc | SettingsInputKind::Sdf
    ) && request.paths.len() != 1
    {
        bail!("Select one settings file")
    }
    for path in request.paths {
        match request.kind {
            SettingsInputKind::IncludeDirectory => {
                if !path.is_dir() {
                    bail!("Not an include directory: {}", path.display())
                }
            }
            SettingsInputKind::Model | SettingsInputKind::Sdc | SettingsInputKind::Sdf => {
                if !path.is_file() {
                    bail!("Not a settings file: {}", path.display())
                }
                let permitted = match request.kind {
                    SettingsInputKind::Model => vec!["v", "sv"],
                    SettingsInputKind::Sdc => vec!["sdc"],
                    SettingsInputKind::Sdf => vec!["sdf"],
                    SettingsInputKind::IncludeDirectory => unreachable!(),
                };
                if !path.extension().is_some_and(|extension| {
                    permitted
                        .iter()
                        .any(|value| extension.eq_ignore_ascii_case(value))
                }) {
                    bail!("Unsupported settings file: {}", path.display())
                }
            }
        }
        references.push(workspace::register(
            &path,
            config_path,
            &mut project,
            matches!(request.kind, SettingsInputKind::IncludeDirectory),
        )?);
    }
    for reference in &references {
        validate_reference(&project, reference)?;
    }
    Ok(SettingsReferences {
        project,
        references,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn project() -> ProjectConfig {
        decode_project(json!({"schema_version":3,"name":"empty","top":"","sources":[]})).unwrap()
    }
    #[test]
    fn empty_projects_have_readiness_warnings_not_errors() {
        let p = project();
        let result = validate(Path::new("/missing/hdlview.project.json"), &p);
        assert!(result.errors.is_empty());
        assert_eq!(result.warnings.len(), 4);
    }
    #[test]
    fn settings_and_project_updates_share_simulation_validation() {
        let mut p = project();
        p.simulations.insert("run".into(), serde_json::from_value(json!({"simulator":"icarus","top":"tb","dut_scope":["wrong","dut"],"testbench":[],"stop_time":"0ns"})).unwrap());
        let result = validate(Path::new("/missing/hdlview.project.json"), &p);
        assert!(result
            .errors
            .iter()
            .any(|e| e.field == "simulations.run.dut_scope"));
        assert!(result
            .errors
            .iter()
            .any(|e| e.field == "simulations.run.stop_time"));
        assert!(validate_project(&p).is_err());
        let cfg = p.simulations.get_mut("run").unwrap();
        cfg.dut_scope = vec!["tb".into(), "dut".into()];
        cfg.stop_time = "1us".into();
        assert!(validate_project(&p).is_ok());
    }
    #[test]
    fn sdf_and_physical_controls_reject_invalid_backend_values() {
        let mut p = project();
        p.simulations.insert("timing".into(), serde_json::from_value(json!({"simulator":"verilator","top":"tb","dut_scope":["tb","dut"],"testbench":[],"sdf":"","use_snapshot_sdf":true,"delay_selection":"fast"})).unwrap());
        p.physical = Some(serde_json::from_value(json!({"pdk":"sky130A","library":"sky130_fd_sc_hd","clock_port":"clk","clock_period_ns":0,"overrides":{"FP_CORE_UTIL":101}})).unwrap());
        let result = validate(Path::new("/missing/hdlview.project.json"), &p);
        for field in [
            "simulations.timing.simulator",
            "simulations.timing.sdf",
            "simulations.timing.delay_selection",
            "physical.clock_period_ns",
            "physical.FP_CORE_UTIL",
        ] {
            assert!(result.errors.iter().any(|e| e.field == field), "{field}");
        }
        assert!(validate_project(&p).is_err());
    }
    #[test]
    fn external_settings_paths_are_draft_only_and_preserve_namespaces() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().join("project");
        let external = temp.path().join("models with spaces");
        std::fs::create_dir(&config).unwrap();
        std::fs::create_dir(&external).unwrap();
        let model = external.join("cell.v");
        std::fs::write(&model, "module cell; endmodule").unwrap();
        let p = project();
        let result = references(
            &config.join("hdlview.project.json"),
            SettingsInputs {
                project: p.clone(),
                kind: SettingsInputKind::Model,
                paths: vec![model.clone()],
            },
        )
        .unwrap();
        assert!(p.source_roots.is_empty());
        assert_eq!(result.project.source_roots.len(), 1);
        assert!(matches!(result.references[0], FileRef::Rooted { .. }));
        assert!(!config.join("hdlview.project.json").exists());
        assert_eq!(
            std::fs::read_to_string(model).unwrap(),
            "module cell; endmodule"
        );
    }
    #[test]
    fn captured_root_include_directory_can_precede_external_compilation_units() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().join("project");
        let external = temp.path().join("external");
        std::fs::create_dir(&config).unwrap();
        std::fs::create_dir(&external).unwrap();
        std::fs::write(external.join("tb.sv"), "module tb; endmodule\n").unwrap();
        std::fs::write(external.join("timing.sdc"), "auxiliary input").unwrap();
        let path = config.join("hdlview.project.json");
        let mut p = project();
        p.source_roots
            .insert("external".into(), "../external".into());
        p.include_dirs.push(FileRef::Rooted {
            root: "external".into(),
            path: ".".into(),
        });
        p.simulation_sources.push(FileRef::Rooted {
            root: "external".into(),
            path: "tb.sv".into(),
        });
        atomic_json(&path, &p).unwrap();
        let output = temp.path().join("scratch");
        let captured = crate::project::capture_cancellable(
            &path,
            &p,
            &output,
            &crate::runner::CancelToken::default(),
        )
        .unwrap();
        assert!(captured.hashes.contains_key("__roots/external/tb.sv"));
        assert!(output.join("inputs/__roots/external/tb.sv").exists());
        assert!(!output.join("inputs/__roots/external/timing.sdc").exists());
    }
    #[test]
    fn legacy_picker_drafts_migrate_references_without_saving() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("project");
        let external = temp.path().join("external");
        std::fs::create_dir(&directory).unwrap();
        std::fs::create_dir(&external).unwrap();
        let tb = external.join("tb.sv");
        std::fs::write(&tb, "module tb; endmodule\n").unwrap();
        let path = directory.join("hdlview.project.json");
        let p = decode_project(json!({"schema_version":1,"name":"legacy","top":"","sources":[],"simulations":{"run":{"simulator":"icarus","top":"tb","dut_scope":["tb","dut"],"testbench":[tb]}}})).unwrap();
        atomic_json(&path, &p).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let result = references(
            &path,
            SettingsInputs {
                project: p,
                kind: SettingsInputKind::IncludeDirectory,
                paths: vec![external],
            },
        )
        .unwrap();
        assert_eq!(result.project.schema_version, 3);
        assert!(matches!(
            result.project.simulations["run"].testbench[0],
            FileRef::Rooted { .. }
        ));
        assert_eq!(result.project.simulations["run"].dut_scope, ["tb", "dut"]);
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert_eq!(
            resolve_reference(
                &path,
                &result.project,
                &result.project.simulations["run"].testbench[0]
            )
            .unwrap(),
            tb
        );
    }
}
