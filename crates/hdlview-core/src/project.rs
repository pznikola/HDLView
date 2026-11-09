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

/// Canonical paths without Windows' `\\?\` form, which Docker and the tools reject.
pub trait Canonical {
    fn canonical(&self) -> std::io::Result<PathBuf>;
}
impl Canonical for Path {
    fn canonical(&self) -> std::io::Result<PathBuf> {
        dunce::canonicalize(self)
    }
}

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
    Ok(path.canonical()?)
}
pub fn load_project(path: &Path) -> Result<ProjectConfig> {
    let mut project = decode_project(read_json(path)?)
        .with_context(|| format!("Load project {}", path.display()))?;
    validate_project(&project)?;
    deduplicate_simulation_files(path, &mut project)?;
    Ok(project)
}
/// Decode a project document and normalize its membership lists.
pub fn decode_project(value: serde_json::Value) -> Result<ProjectConfig> {
    let mut project: ProjectConfig = serde_json::from_value(value)?;
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
            for exclusion in record.exclusions {
                if !previous.exclusions.contains(&exclusion) {
                    previous.exclusions.push(exclusion);
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
        .canonical()?;
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
            let root = root.canonical().unwrap_or(root);
            let input = root.join(file.path());
            // Missing files remain visible; existing aliases resolve to one membership entry.
            let identity = input.canonical().unwrap_or_else(|_| {
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
    validate(p, false)
}
/// A captured project names its copied external inputs under `__roots`.
pub fn validate_captured(p: &ProjectConfig) -> Result<()> {
    validate(p, true)
}
fn validate(p: &ProjectConfig, captured: bool) -> Result<()> {
    if let Some(issue) = crate::settings::field_errors(p).first() {
        bail!("{}: {}", issue.field, issue.message)
    }
    if p.schema_version != PROJECT_SCHEMA {
        bail!("Unsupported project schema {}", p.schema_version)
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
        check_reference(p, captured, &s.path)?;
    }
    for reference in p
        .headers
        .iter()
        .chain(&p.include_dirs)
        .chain(&p.assets)
        .chain(&p.simulation_sources)
        .chain(&p.simulation_headers)
    {
        check_reference(p, captured, reference)?;
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
        check_reference(p, captured, &import.location)?;
        for reference in &import.files {
            check_reference(p, captured, reference)?;
        }
        for exclusion in &import.exclusions {
            check_reference(p, captured, &exclusion.path)?;
        }
    }
    for (name, simulation) in &p.simulations {
        for (index, file) in simulation.testbench.iter().enumerate() {
            validate_hdl(file, false)
                .with_context(|| format!("simulations.{name}.testbench[{index}]"))?;
        }
        for reference in simulation
            .testbench
            .iter()
            .chain(&simulation.models)
            .chain(&simulation.sdf)
        {
            check_reference(p, captured, reference)?;
        }
    }
    if let Some(sdc) = p.physical.as_ref().and_then(|p| p.sdc.as_ref()) {
        check_reference(p, captured, sdc)?;
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
    check_reference(project, false, reference)
}
fn check_reference(project: &ProjectConfig, captured: bool, reference: &FileRef) -> Result<()> {
    relative(reference.path())?;
    if let FileRef::Rooted { root, .. } = reference {
        if !project.source_roots.contains_key(root) {
            bail!("Unknown source root {root}")
        }
    } else if !captured && reference.path().starts_with("__roots") {
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
        .canonical()?;
    let root = match reference {
        FileRef::Local(_) => directory,
        FileRef::Rooted { root, .. } => directory
            .join(
                project
                    .source_roots
                    .get(root)
                    .context("Unknown source root")?,
            )
            .canonical()?,
    };
    let path = root
        .join(reference.path())
        .canonical()
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
    cancel: &crate::runner::CancelToken,
    hdl_only: bool,
) -> Result<()> {
    cancel.check()?;
    relative(rel)?;
    let src = root.join(rel);
    let canonical = src
        .canonical()
        .with_context(|| format!("Missing input {}", src.display()))?;
    if !canonical.starts_with(root) {
        bail!("Input symlink escapes project: {}", src.display())
    }
    if fs::symlink_metadata(&src)?.file_type().is_symlink() && canonical.is_dir() {
        bail!("Directory symlinks are not accepted as input directories")
    }
    if canonical.is_dir() {
        // A registered root uses "."; creating a missing namespace ending in "/." fails.
        fs::create_dir_all(out.join(rel).components().collect::<PathBuf>())?;
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
            copy_tree(root, &rel.join(name), out, hashes, cancel, hdl_only)?;
        }
    } else {
        if hdl_only && hdl_language(&canonical).is_none() {
            return Ok(());
        }
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
    capture_inputs(
        project_path,
        p,
        directory,
        &crate::runner::CancelToken::default(),
        false,
    )
}

pub(crate) fn capture_cancellable(
    project_path: &Path,
    p: &ProjectConfig,
    directory: &Path,
    cancel: &crate::runner::CancelToken,
) -> Result<CapturedInputs> {
    capture_inputs(project_path, p, directory, cancel, true)
}

fn capture_inputs(
    project_path: &Path,
    p: &ProjectConfig,
    directory: &Path,
    cancel: &crate::runner::CancelToken,
    hdl_only: bool,
) -> Result<CapturedInputs> {
    let project_path = project_path.canonical()?;
    let root = project_path.parent().context("Missing project directory")?;
    let output = directory.join("inputs");
    fs::create_dir_all(&output)?;
    let mut normalized = p.clone();
    let mut hashes = BTreeMap::new();
    let mut origins = BTreeMap::new();
    let mut copy = |reference: &FileRef| -> Result<FileRef> {
        let src = resolve_reference(&project_path, p, reference)?;
        let logical = reference.logical();
        let source_root = match reference {
            FileRef::Local(_) => root.to_path_buf(),
            FileRef::Rooted { root: name, .. } => root.join(&p.source_roots[name]).canonical()?,
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
            cancel,
            hdl_only,
        )
        .with_context(|| format!("Capture input {}", src.display()))?;
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
                let key = portable(&FileRef::Local(logical.to_path_buf()).logical());
                hashes.insert(
                    key.clone(),
                    file_hash(&output.join(logical)).with_context(|| {
                        format!("Hash captured input {}", output.join(logical).display())
                    })?,
                );
                origins.insert(key, src.canonical()?);
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
    let value: serde_json::Value = read_json(path)?;
    if value["schema_version"] != SCHEMA {
        bail!("Unsupported snapshot schema; rebuild the design")
    }
    let s: DesignSnapshot = serde_json::from_value(value)?;
    let actual = path.canonical()?.parent().unwrap().to_path_buf();
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
    let origin: (Option<PathBuf>, Option<String>) =
        read_json(&s.directory.join("project-origin.json"))?;
    if origin != (s.project_path.clone(), s.project_fingerprint.clone()) {
        bail!("Snapshot project provenance changed")
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
    fn membership_merges_by_file_identity_and_opening_never_writes() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("hdlview.project.json");
        fs::create_dir(d.path().join("rtl")).unwrap();
        for name in ["rtl/tb.sv", "rtl/other.sv", "extra.sv", "z.sv"] {
            fs::write(d.path().join(name), "").unwrap();
        }
        let original = serde_json::json!({
            "schema_version":3,"name":"membership","top":"top","sources":[],
            "source_roots":{"rtl":"rtl"},
            "simulation_sources":["rtl/tb.sv",{"root":"rtl","path":"tb.sv"},"rtl/other.sv"],
            "imports":[
                {"kind":"filelist","location":"list.f","group":"simulation","files":["rtl/tb.sv"]},
                {"kind":"filelist","location":"list.f","group":"simulation","files":["rtl/other.sv"]},
                {"kind":"filelist","location":"list.f","group":"simulation","working_directory":"different","files":["extra.sv"]}
            ],
            "simulations":{
                "z":{"simulator":"icarus","top":"tb","dut_scope":["tb","dut"],"testbench":["z.sv"]},
                "a":{"simulator":"icarus","top":"tb","dut_scope":["tb","dut"],"testbench":["extra.sv","rtl/tb.sv"]}
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
        assert_eq!(working.project.imports.len(), 2);
        assert_eq!(working.project.imports[0].files.len(), 2);
    }
    #[test]
    fn other_schemas_unknown_fields_and_unsupported_files_are_errors() {
        let base = serde_json::json!({"schema_version":3,"name":"p","top":"","sources":[]});
        let mut tb = base.clone();
        tb["simulations"] = serde_json::json!({"rtl":{"simulator":"icarus","top":"tb","testbench":["tb.vhd"],"dut_scope":["tb","dut"]}});
        let error = validate_project(&decode_project(tb).unwrap()).unwrap_err();
        assert!(format!("{error:#}").contains("tb.vhd"));
        let mut unknown = base.clone();
        unknown["unknown_field"] = serde_json::json!([]);
        assert!(decode_project(unknown)
            .unwrap_err()
            .to_string()
            .contains("unknown_field"));
        let mut older = base.clone();
        older["schema_version"] = 2.into();
        assert!(validate_project(&decode_project(older).unwrap())
            .unwrap_err()
            .to_string()
            .contains("Unsupported project schema 2"));
        let mut unversioned = base;
        unversioned
            .as_object_mut()
            .unwrap()
            .remove("schema_version");
        assert!(decode_project(unversioned)
            .unwrap_err()
            .to_string()
            .contains("schema_version"));
    }
    #[test]
    fn only_a_captured_project_may_name_the_reserved_input_namespace() {
        let project = decode_project(serde_json::json!({
            "schema_version":3,"name":"p","top":"","sources":[],"simulation_sources":["__roots/external/tb.sv"]
        }))
        .unwrap();
        assert!(validate_project(&project).is_err());
        assert!(validate_captured(&project).is_ok());
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
        let root = d.path().canonical().unwrap();
        fs::write(root.join("top.v"), "old").unwrap();
        let o = tempfile::tempdir().unwrap();
        let mut h = BTreeMap::new();
        copy_tree(
            &root,
            Path::new("top.v"),
            o.path(),
            &mut h,
            &crate::runner::CancelToken::default(),
            false,
        )
        .unwrap();
        fs::write(root.join("top.v"), "new").unwrap();
        assert_eq!(fs::read_to_string(o.path().join("top.v")).unwrap(), "old");
    }
    #[test]
    fn lint_capture_excludes_non_hdl_and_preserves_empty_include_directories() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = crate::workspace::create(
            &directory.path().join("hdlview.project.json"),
            "capture".into(),
            false,
        )
        .unwrap();
        fs::create_dir(directory.path().join("include")).unwrap();
        fs::write(directory.path().join("include/unrelated.bin"), "private").unwrap();
        let mut project = workspace.project;
        project.include_dirs.push("include".into());
        let output = tempfile::tempdir().unwrap();
        let captured = capture_cancellable(
            &workspace.path,
            &project,
            output.path(),
            &crate::runner::CancelToken::default(),
        )
        .unwrap();
        assert!(captured.hashes.is_empty());
        assert!(output.path().join("inputs/include").is_dir());
        assert!(!output.path().join("inputs/include/unrelated.bin").exists());
    }
}
