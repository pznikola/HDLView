use crate::{model::*, runner::identifier};
use anyhow::{bail, Context, Result};
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T> {
    serde_json::from_slice(&fs::read(path).with_context(|| format!("Read {}", path.display()))?)
        .with_context(|| format!("Parse {}", path.display()))
}
pub fn atomic_json(path: &Path, value: &impl serde::Serialize) -> Result<()> {
    static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let sequence = SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = path.with_extension(format!("{}.{sequence}.tmp", std::process::id()));
    fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
    fs::rename(tmp, path)?;
    Ok(())
}
pub fn hash(data: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(data.as_ref()))
}
pub fn file_hash(path: &Path) -> Result<String> {
    use std::io::Read;
    let mut f = fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut b = [0u8; 65536];
    loop {
        let n = f.read(&mut b)?;
        if n == 0 {
            break;
        }
        h.update(&b[..n]);
    }
    Ok(format!("{:x}", h.finalize()))
}
pub fn unique_dir(store: &Path, prefix: &str) -> Result<PathBuf> {
    fs::create_dir_all(store)?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let path = store.join(format!("{prefix}-{}-{now}", std::process::id()));
    fs::create_dir(&path)?;
    Ok(path.canonicalize()?)
}
pub fn load_project(path: &Path) -> Result<ProjectConfig> {
    let mut project = decode_project(read_json(path)?)
        .with_context(|| format!("Load project {}", path.display()))?;
    validate_project(&project)?;
    deduplicate_simulation_files(path, &mut project)?;
    Ok(project)
}
/// Normalize supported legacy documents before decoding the current contracts.
/// This conversion never writes the configuration or captured artifact.
pub fn decode_project(mut value: serde_json::Value) -> Result<ProjectConfig> {
    let document = value
        .as_object_mut()
        .context("Project must be a JSON object")?;
    let version = document
        .get("schema_version")
        .and_then(|v| v.as_u64())
        .unwrap_or(1);
    if ![1, 2, u64::from(PROJECT_SCHEMA)].contains(&version) {
        bail!("Unsupported project schema {version}")
    }
    if document.get("project_language").and_then(|v| v.as_str()) == Some("vhdl") {
        bail!("project_language: VHDL projects are no longer supported")
    }
    if let Some(sources) = document.get_mut("sources").and_then(|v| v.as_array_mut()) {
        for (index, source) in sources.iter_mut().enumerate() {
            if source.get("language").and_then(|v| v.as_str()) == Some("vhdl") {
                bail!("sources[{index}].language: VHDL is no longer supported")
            }
            if version < 3 {
                if let Some(source) = source.as_object_mut() {
                    source.remove("library");
                }
            }
        }
    }
    if let Some(simulations) = document
        .get_mut("simulations")
        .and_then(|v| v.as_object_mut())
    {
        for (name, simulation) in simulations {
            if simulation.get("simulator").and_then(|v| v.as_str()) == Some("ghdl") {
                bail!("simulations.{name}.simulator: GHDL is no longer supported")
            }
            if version < 3 {
                if let Some(simulation) = simulation.as_object_mut() {
                    simulation.remove("stage");
                }
            }
        }
    }
    if version < 3 {
        document.remove("project_language");
        for (old, new) in [
            ("gate_simulation_sources", "simulation_sources"),
            ("gate_simulation_headers", "simulation_headers"),
        ] {
            if let Some(files) = document.remove(old) {
                let files = files
                    .as_array()
                    .with_context(|| format!("{old} must be an array"))?;
                let target = document
                    .entry(new)
                    .or_insert_with(|| serde_json::json!([]))
                    .as_array_mut()
                    .with_context(|| format!("{new} must be an array"))?;
                target.extend(files.iter().cloned());
            }
        }
        if let Some(imports) = document.get_mut("imports").and_then(|v| v.as_array_mut()) {
            for import in imports {
                if matches!(
                    import.get("group").and_then(|v| v.as_str()),
                    Some("rtl_simulation" | "gate_simulation")
                ) {
                    import["group"] = serde_json::json!("simulation");
                }
            }
        }
    }
    let mut project: ProjectConfig = serde_json::from_value(value)?;
    if project.technology.is_none() {
        project.technology = project
            .physical
            .as_ref()
            .and_then(|p| match p.pdk.as_str() {
                "sky130A" => Some(Technology::Sky130),
                "ihp-sg13g2" => Some(Technology::IhpSg13g2),
                _ => None,
            });
    }
    for config in project.simulations.values() {
        project
            .simulation_sources
            .extend(config.testbench.iter().cloned());
    }
    for files in [
        &mut project.simulation_sources,
        &mut project.simulation_headers,
    ] {
        let mut seen = std::collections::BTreeSet::new();
        files.retain(|file| seen.insert(file.clone()));
    }
    let mut imports: Vec<ImportRecord> = Vec::new();
    for record in project.imports {
        if let Some(previous) = imports.iter_mut().find(|r| {
            r.group == record.group
                && r.kind == record.kind
                && r.location == record.location
                && r.working_directory == record.working_directory
        }) {
            for file in record.files {
                if !previous.files.contains(&file) {
                    previous.files.push(file);
                }
            }
        } else {
            imports.push(record);
        }
    }
    project.imports = imports;
    Ok(project)
}
pub(crate) fn deduplicate_simulation_files(path: &Path, project: &mut ProjectConfig) -> Result<()> {
    let directory = path
        .parent()
        .context("Project has no directory")?
        .canonicalize()?;
    for files in [
        &mut project.simulation_sources,
        &mut project.simulation_headers,
    ] {
        let mut seen = std::collections::BTreeSet::new();
        files.retain(|file| {
            let root = match file {
                FileRef::Local(_) => directory.clone(),
                FileRef::Rooted { root, .. } => directory.join(&project.source_roots[root]),
            };
            let root = root.canonicalize().unwrap_or(root);
            let input = root.join(file.path());
            // Missing files remain visible; existing aliases resolve to one membership entry.
            let identity = input.canonicalize().unwrap_or_else(|_| {
                input
                    .components()
                    .filter(|c| !matches!(c, Component::CurDir))
                    .collect()
            });
            seen.insert(identity)
        });
    }
    Ok(())
}
pub fn hdl_language(path: &Path) -> Option<Language> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "v" | "vh" => Some(Language::Verilog),
        "sv" | "svh" => Some(Language::SystemVerilog),
        _ => None,
    }
}
pub fn validate_hdl(file: &FileRef, header: bool) -> Result<()> {
    hdl_language(file.path()).with_context(|| {
        format!(
            "Unsupported HDL file {}; only Verilog/SystemVerilog is supported",
            file.path().display()
        )
    })?;
    let is_header = file
        .path()
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("vh") || e.eq_ignore_ascii_case("svh"));
    if is_header != header {
        bail!(
            "{}: headers must be registered separately from compilation units",
            file.path().display()
        )
    }
    Ok(())
}
pub fn validate_project(p: &ProjectConfig) -> Result<()> {
    if ![1, 2, PROJECT_SCHEMA].contains(&p.schema_version) {
        bail!("Unsupported project schema {}", p.schema_version)
    }
    if p.name.trim().is_empty() {
        bail!("Project name is required")
    }
    if !p.top.is_empty() {
        identifier(&p.top)?;
    }
    for root in p.source_roots.keys() {
        identifier(root)?;
        if root.contains(['.', '$']) {
            bail!("Invalid source root {root}")
        }
    }
    for s in &p.sources {
        validate_hdl(&s.path, false)?;
        if hdl_language(s.path.path()) != Some(s.language.clone()) {
            bail!(
                "Declared source language does not match {}",
                s.path.path().display()
            )
        }
        validate_reference(p, &s.path)?;
    }
    for reference in p
        .headers
        .iter()
        .chain(&p.include_dirs)
        .chain(&p.assets)
        .chain(&p.simulation_sources)
        .chain(&p.simulation_headers)
    {
        if p.schema_version == 1
            && reference.path().is_absolute()
            && p.simulation_sources.contains(reference)
        {
            continue;
        }
        validate_reference(p, reference)?;
    }
    for (files, header) in [
        (&p.headers, true),
        (&p.simulation_sources, false),
        (&p.simulation_headers, true),
    ] {
        for file in files {
            validate_hdl(file, header)?;
        }
    }
    if let (Some(technology), Some(physical)) = (p.technology, &p.physical) {
        if technology.preset() != (physical.pdk.as_str(), physical.library.as_str()) {
            bail!("Technology and physical library configuration disagree")
        }
    }
    for import in &p.imports {
        if !["folder", "filelist"].contains(&import.kind.as_str()) {
            bail!("Unsupported import kind")
        }
        validate_reference(p, &import.location)?;
        for reference in &import.files {
            validate_reference(p, reference)?;
        }
    }
    for (name, simulation) in &p.simulations {
        for (index, file) in simulation.testbench.iter().enumerate() {
            validate_hdl(file, false)
                .with_context(|| format!("simulations.{name}.testbench[{index}]"))?;
        }
        if (simulation.sdf.is_some() || simulation.use_snapshot_sdf)
            && simulation.simulator != Simulator::Icarus
        {
            bail!("simulations.{name}: SDF simulation requires Icarus")
        }
        for reference in simulation
            .testbench
            .iter()
            .chain(&simulation.models)
            .chain(&simulation.sdf)
        {
            if p.schema_version == 1 && reference.path().is_absolute() {
                continue;
            }
            validate_reference(p, reference)?;
        }
    }
    if let Some(sdc) = p.physical.as_ref().and_then(|p| p.sdc.as_ref()) {
        validate_reference(p, sdc)?;
    }
    for k in p.parameters.keys().chain(p.defines.keys()) {
        identifier(k)?;
    }
    for s in p.simulations.values() {
        identifier(&s.top)?;
        for c in &s.dut_scope {
            identifier(c)?;
        }
        if s.dut_scope.is_empty() {
            bail!("Simulation requires a DUT scope")
        }
    }
    Ok(())
}
pub fn validate_build(p: &ProjectConfig) -> Result<()> {
    validate_project(p)?;
    identifier(&p.top).context("Set the top module before building")?;
    if p.sources.is_empty() {
        bail!("Add at least one design source before building")
    }
    Ok(())
}
pub fn validate_reference(project: &ProjectConfig, reference: &FileRef) -> Result<()> {
    relative(reference.path())?;
    if let FileRef::Rooted { root, .. } = reference {
        if project.schema_version < 2 || !project.source_roots.contains_key(root) {
            bail!("Unknown source root {root}")
        }
    } else if project.schema_version >= 2 && reference.path().starts_with("__roots") {
        bail!("__roots is reserved for captured external inputs")
    }
    Ok(())
}
pub fn resolve_reference(
    project_path: &Path,
    project: &ProjectConfig,
    reference: &FileRef,
) -> Result<PathBuf> {
    validate_reference(project, reference)?;
    let directory = project_path
        .parent()
        .context("Project configuration needs a directory")?
        .canonicalize()?;
    let root = match reference {
        FileRef::Local(_) => directory,
        FileRef::Rooted { root, .. } => directory
            .join(
                project
                    .source_roots
                    .get(root)
                    .context("Unknown source root")?,
            )
            .canonicalize()?,
    };
    let path = root
        .join(reference.path())
        .canonicalize()
        .with_context(|| format!("Missing input {}", root.join(reference.path()).display()))?;
    if !path.starts_with(root) {
        bail!("Input symlink escapes its registered source root")
    }
    Ok(path)
}
pub fn relative(path: &Path) -> Result<()> {
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        bail!(
            "Project paths must be relative and cannot escape the project: {}",
            path.display()
        )
    }
    Ok(())
}
fn copy_tree(
    root: &Path,
    rel: &Path,
    out: &Path,
    hashes: &mut BTreeMap<String, String>,
) -> Result<()> {
    relative(rel)?;
    let src = root.join(rel);
    let canonical = src
        .canonicalize()
        .with_context(|| format!("Missing input {}", src.display()))?;
    if !canonical.starts_with(root) {
        bail!("Input symlink escapes project: {}", src.display())
    }
    if fs::symlink_metadata(&src)?.file_type().is_symlink() && canonical.is_dir() {
        bail!("Directory symlinks are not accepted as input directories")
    }
    if canonical.is_dir() {
        for entry in fs::read_dir(&src)? {
            let e = entry?;
            if e.file_type()?.is_symlink() {
                continue;
            }
            let name = e.file_name();
            if [
                ".git",
                "node_modules",
                "target",
                ".hdlview",
                ".venv",
                "dist",
                "__pycache__",
            ]
            .contains(&name.to_string_lossy().as_ref())
            {
                continue;
            }
            copy_tree(root, &rel.join(name), out, hashes)?;
        }
    } else {
        let bytes = fs::read(&canonical)?;
        hashes.insert(rel.to_string_lossy().into(), hash(&bytes));
        let dst = out.join(rel);
        fs::create_dir_all(dst.parent().unwrap())?;
        fs::write(dst, bytes)?;
    }
    Ok(())
}
pub struct CapturedInputs {
    pub project: ProjectConfig,
    pub hashes: BTreeMap<String, String>,
    pub origins: BTreeMap<String, PathBuf>,
}
pub fn capture(project_path: &Path, p: &ProjectConfig, directory: &Path) -> Result<CapturedInputs> {
    let project_path = project_path.canonicalize()?;
    let root = project_path.parent().context("Missing project directory")?;
    let output = directory.join("inputs");
    fs::create_dir_all(&output)?;
    let mut normalized = p.clone();
    let mut hashes = BTreeMap::new();
    let mut origins = BTreeMap::new();
    let mut copy = |reference: &FileRef| -> Result<FileRef> {
        // Legacy absolute model locations belong to the tool installation.
        if p.schema_version == 1 && reference.path().is_absolute() {
            return Ok(reference.clone());
        }
        let src = resolve_reference(&project_path, p, reference)?;
        let logical = reference.logical();
        let source_root = match reference {
            FileRef::Local(_) => root.to_path_buf(),
            FileRef::Rooted { root: name, .. } => {
                root.join(&p.source_roots[name]).canonicalize()?
            }
        };
        let namespace = match reference {
            FileRef::Local(_) => output.clone(),
            FileRef::Rooted { root: name, .. } => output.join("__roots").join(name),
        };
        copy_tree(
            &source_root,
            reference.path(),
            &namespace,
            &mut BTreeMap::new(),
        )?;
        fn collect(
            src: &Path,
            logical: &Path,
            output: &Path,
            hashes: &mut BTreeMap<String, String>,
            origins: &mut BTreeMap<String, PathBuf>,
        ) -> Result<()> {
            if src.is_dir() {
                for e in fs::read_dir(output.join(logical))? {
                    let e = e?;
                    collect(
                        &src.join(e.file_name()),
                        &logical.join(e.file_name()),
                        output,
                        hashes,
                        origins,
                    )?;
                }
            } else {
                let key = FileRef::Local(logical.to_path_buf())
                    .logical()
                    .to_string_lossy()
                    .into_owned();
                hashes.insert(key.clone(), file_hash(&output.join(logical))?);
                origins.insert(key, src.canonicalize()?);
            }
            Ok(())
        }
        collect(&src, &logical, &output, &mut hashes, &mut origins)?;
        Ok(FileRef::Local(logical))
    };
    for source in &mut normalized.sources {
        let original = source.path.clone();
        // Include files beside a source retain their relative include relationship.
        let src = resolve_reference(&project_path, p, &original)?;
        for entry in fs::read_dir(src.parent().context("Source has no directory")?)? {
            let entry = entry?;
            if entry
                .path()
                .extension()
                .is_some_and(|x| x == "vh" || x == "svh")
            {
                let path = original
                    .path()
                    .parent()
                    .unwrap_or(Path::new(""))
                    .join(entry.file_name());
                let sibling = match &original {
                    FileRef::Local(_) => FileRef::Local(path),
                    FileRef::Rooted { root, .. } => FileRef::Rooted {
                        root: root.clone(),
                        path,
                    },
                };
                copy(&sibling)?;
            }
        }
        source.path = copy(&original)?;
    }
    for reference in normalized
        .headers
        .iter_mut()
        .chain(&mut normalized.include_dirs)
        .chain(&mut normalized.assets)
        .chain(&mut normalized.simulation_sources)
        .chain(&mut normalized.simulation_headers)
    {
        *reference = copy(reference)?;
    }
    for simulation in normalized.simulations.values_mut() {
        for reference in simulation
            .testbench
            .iter_mut()
            .chain(&mut simulation.models)
            .chain(&mut simulation.sdf)
        {
            *reference = copy(reference)?;
        }
    }
    if let Some(sdc) = normalized.physical.as_mut().and_then(|p| p.sdc.as_mut()) {
        *sdc = copy(sdc)?;
    }
    for import in &p.imports {
        if import.kind == "filelist" {
            copy(&import.location)?;
        }
    }
    normalized.source_roots.clear();
    normalized.imports.clear();
    // The captured configuration uses only local paths, including reserved namespaces.
    normalized.schema_version = 1;
    atomic_json(&directory.join("project.json"), &normalized)?;
    atomic_json(&directory.join("input-hashes.json"), &hashes)?;
    atomic_json(&directory.join("source-origins.json"), &origins)?;
    Ok(CapturedInputs {
        project: normalized,
        hashes,
        origins,
    })
}
pub fn read_snapshot(path: &Path) -> Result<DesignSnapshot> {
    let mut value: serde_json::Value = read_json(path)?;
    let project =
        decode_project(value["project"].take()).context("Snapshot project is unsupported")?;
    value["project"] = serde_json::to_value(project)?;
    let s: DesignSnapshot = serde_json::from_value(value)?;
    if s.schema_version != SCHEMA {
        bail!("Unsupported snapshot schema")
    }
    let actual = path.canonicalize()?.parent().unwrap().to_path_buf();
    if s.directory != actual {
        bail!("Snapshot was moved; reopen it at its original artifact directory")
    }
    for (name, expected) in &s.input_hashes {
        if file_hash(&s.directory.join("inputs").join(name))? != *expected {
            bail!("Snapshot input changed: {name}")
        }
    }
    for (name, expected) in &s.artifact_hashes {
        relative(Path::new(name))?;
        if file_hash(&s.directory.join(name))? != *expected {
            bail!("Snapshot artifact changed: {name}")
        }
    }
    if s.artifact_hashes.contains_key("project-origin.json") {
        let origin: (Option<PathBuf>, Option<String>) =
            read_json(&s.directory.join("project-origin.json"))?;
        if origin != (s.project_path.clone(), s.project_fingerprint.clone()) {
            bail!("Snapshot project provenance changed")
        }
    }
    Ok(s)
}

/// Yosys uses file:line.column-line.column; Slang helpers use file:line:column.
pub fn source_location(raw: &str) -> (&str, String, String) {
    let first = raw.split('|').next().unwrap_or(raw);
    if let Some((prefix, last)) = first.rsplit_once(':') {
        if let Some((file, line)) = prefix.rsplit_once(':') {
            if line.parse::<u64>().is_ok() {
                return (file, line.into(), last.into());
            }
        }
        let mut numbers = last.split(['.', '-']);
        return (
            prefix,
            numbers.next().unwrap_or("1").into(),
            numbers.next().unwrap_or("1").into(),
        );
    }
    (first, "1".into(), "1".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_membership_merges_by_file_identity_and_saves_only_on_request() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("hdlview.project.json");
        fs::create_dir(d.path().join("rtl")).unwrap();
        for name in [
            "rtl/tb.sv",
            "rtl/other.sv",
            "rtl/defs.svh",
            "extra.sv",
            "z.sv",
        ] {
            fs::write(d.path().join(name), "").unwrap();
        }
        let original = serde_json::json!({
            "schema_version":2,"name":"legacy","top":"top","sources":[],"project_language":"system_verilog",
            "source_roots":{"rtl":"rtl"},"simulation_sources":["rtl/tb.sv"],
            "gate_simulation_sources":[{"root":"rtl","path":"tb.sv"},"rtl/other.sv"],
            "simulation_headers":["rtl/defs.svh"],"gate_simulation_headers":[{"root":"rtl","path":"defs.svh"}],
            "imports":[
                {"kind":"filelist","location":"list.f","group":"rtl_simulation","files":["rtl/tb.sv"]},
                {"kind":"filelist","location":"list.f","group":"gate_simulation","files":["rtl/other.sv"]},
                {"kind":"filelist","location":"list.f","group":"gate_simulation","working_directory":"different","files":["extra.sv"]}
            ],
            "simulations":{
                "z":{"stage":"gate","simulator":"icarus","top":"tb","dut_scope":["tb","dut"],"testbench":["z.sv"]},
                "a":{"stage":"rtl","simulator":"icarus","top":"tb","dut_scope":["tb","dut"],"testbench":["extra.sv","rtl/tb.sv"]}
            }
        });
        atomic_json(&path, &original).unwrap();
        let before = fs::read(&path).unwrap();
        let working = crate::workspace::open(&path).unwrap();
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(
            working.project.simulation_sources,
            ["rtl/tb.sv", "rtl/other.sv", "extra.sv", "z.sv"].map(FileRef::from)
        );
        assert_eq!(
            working.project.simulation_headers,
            vec![FileRef::from("rtl/defs.svh")]
        );
        assert_eq!(
            working.project.simulations["a"].testbench,
            vec![FileRef::from("extra.sv"), FileRef::from("rtl/tb.sv")]
        );
        assert_eq!(working.project.imports.len(), 2);
        assert_eq!(working.project.imports[0].files.len(), 2);
        assert!(working
            .project
            .imports
            .iter()
            .all(|r| r.group == SourceGroup::Simulation));
        let saved = crate::workspace::save(&working, &working.revision).unwrap();
        let written: serde_json::Value = read_json(&path).unwrap();
        assert_eq!(written["schema_version"], PROJECT_SCHEMA);
        for field in [
            "project_language",
            "gate_simulation_sources",
            "gate_simulation_headers",
        ] {
            assert!(written.get(field).is_none());
        }
        assert!(written["simulations"]["a"].get("stage").is_none());
        assert_eq!(
            saved.project.simulation_sources,
            working.project.simulation_sources
        );
    }
    #[test]
    fn unsupported_projects_and_stale_schema_three_fields_are_located_errors() {
        let base = serde_json::json!({"schema_version":2,"name":"legacy","top":"","sources":[]});
        let mut family = base.clone();
        family["project_language"] = "vhdl".into();
        assert!(decode_project(family)
            .unwrap_err()
            .to_string()
            .contains("project_language"));
        let mut source = base.clone();
        source["sources"] = serde_json::json!([{"path":"top.vhd","language":"vhdl"}]);
        assert!(decode_project(source)
            .unwrap_err()
            .to_string()
            .contains("sources[0].language"));
        let mut simulator = base.clone();
        simulator["simulations"] = serde_json::json!({"rtl":{"simulator":"ghdl","top":"tb","testbench":[],"dut_scope":["tb","dut"]}});
        assert!(decode_project(simulator)
            .unwrap_err()
            .to_string()
            .contains("simulations.rtl.simulator"));
        let mut tb = base;
        tb["simulations"] = serde_json::json!({"rtl":{"simulator":"icarus","top":"tb","testbench":["tb.vhd"],"dut_scope":["tb","dut"]}});
        let error = validate_project(&decode_project(tb).unwrap()).unwrap_err();
        assert!(format!("{error:#}").contains("tb.vhd"));
        let stale = serde_json::json!({"schema_version":3,"name":"new","top":"","sources":[],"gate_simulation_sources":[]});
        assert!(decode_project(stale)
            .unwrap_err()
            .to_string()
            .contains("gate_simulation_sources"));
    }
    #[test]
    fn schema_one_absolute_testbench_references_migrate_to_registered_roots() {
        let d = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let tb = external.path().join("tb.sv");
        fs::write(&tb, "module tb; endmodule").unwrap();
        let path = d.path().join("hdlview.project.json");
        atomic_json(&path, &serde_json::json!({"schema_version":1,"name":"old","top":"","sources":[],"simulations":{"run":{"simulator":"icarus","top":"tb","dut_scope":["tb","dut"],"testbench":[tb]}}})).unwrap();
        let working = crate::workspace::open(&path).unwrap();
        let saved = crate::workspace::save(&working, &working.revision).unwrap();
        assert_eq!(saved.project.schema_version, 3);
        assert_eq!(
            saved.project.simulation_sources,
            saved.project.simulations["run"].testbench
        );
        assert_eq!(
            resolve_reference(&path, &saved.project, &saved.project.simulation_sources[0]).unwrap(),
            tb
        );
    }
    #[test]
    fn reject_escape() {
        assert!(relative(Path::new("../top.v")).is_err());
        assert!(relative(Path::new("/top.v")).is_err());
        assert!(relative(Path::new("rtl/top.v")).is_ok());
    }
    #[test]
    fn copy_is_immutable() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("top.v"), "old").unwrap();
        let o = tempfile::tempdir().unwrap();
        let mut h = BTreeMap::new();
        copy_tree(d.path(), Path::new("top.v"), o.path(), &mut h).unwrap();
        fs::write(d.path().join("top.v"), "new").unwrap();
        assert_eq!(fs::read_to_string(o.path().join("top.v")).unwrap(), "old");
    }
}
