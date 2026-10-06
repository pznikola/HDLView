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
    let p: ProjectConfig = read_json(path)?;
    validate_project(&p)?;
    Ok(p)
}
pub fn validate_project(p: &ProjectConfig) -> Result<()> {
    if p.schema_version != SCHEMA {
        bail!("Unsupported project schema {}", p.schema_version)
    }
    identifier(&p.top)?;
    if p.sources.is_empty() {
        bail!("At least one design source is required")
    }
    let vhdl = p.sources.iter().any(|s| s.language == Language::Vhdl);
    if vhdl && p.sources.iter().any(|s| s.language != Language::Vhdl) {
        bail!("Mixed VHDL/Verilog projects are not supported")
    }
    for s in &p.sources {
        relative(&s.path)?;
        if let Some(l) = &s.library {
            identifier(l)?;
        }
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
            let name = e.file_name();
            if [".git", "node_modules", "target", ".hdlview", ".venv"]
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
pub fn capture(
    project_path: &Path,
    p: &ProjectConfig,
    directory: &Path,
) -> Result<BTreeMap<String, String>> {
    let root = project_path.canonicalize()?.parent().unwrap().to_path_buf();
    let output = directory.join("inputs");
    fs::create_dir_all(&output)?;
    let mut paths: Vec<PathBuf> = p
        .sources
        .iter()
        .map(|s| s.path.clone())
        .chain(p.include_dirs.clone())
        .chain(p.assets.clone())
        .collect();
    // Capture sibling includes, since both Slang and GHDL resolve them beside sources.
    for s in &p.sources {
        if let Some(parent) = s.path.parent() {
            let dir = root.join(parent);
            for e in fs::read_dir(dir)? {
                let e = e?;
                if e.path()
                    .extension()
                    .is_some_and(|x| x == "vh" || x == "svh")
                {
                    paths.push(parent.join(e.file_name()));
                }
            }
        }
    }
    for s in p.simulations.values() {
        paths.extend(s.testbench.clone());
        paths.extend(s.models.iter().filter(|p| p.is_relative()).cloned());
        if let Some(sdf) = &s.sdf {
            paths.push(sdf.clone());
        }
    }
    if let Some(cfg) = &p.physical {
        if let Some(sdc) = &cfg.sdc {
            paths.push(sdc.clone());
        }
    }
    let mut hashes = BTreeMap::new();
    for path in paths {
        copy_tree(&root, &path, &output, &mut hashes)?;
    }
    atomic_json(&directory.join("project.json"), p)?;
    atomic_json(&directory.join("input-hashes.json"), &hashes)?;
    Ok(hashes)
}
pub fn read_snapshot(path: &Path) -> Result<DesignSnapshot> {
    let s: DesignSnapshot = read_json(path)?;
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
    Ok(s)
}

/// Yosys uses file:line.column-line.column; Slang/GHDL helpers use file:line:column.
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
