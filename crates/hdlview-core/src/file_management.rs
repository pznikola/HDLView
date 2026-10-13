//! Working-file operations. Configuration publication remains an explicit project save.
use crate::{
    model::*,
    project::*,
    runner::CancelToken,
    workspace::{self, WorkspaceProject},
};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path, PathBuf},
};

#[derive(Clone, Serialize, Deserialize)]
pub struct CreateEntry {
    pub directory: PathBuf,
    pub name: String,
    pub group: SourceGroup,
    pub folder: bool,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    Rename,
    Remove,
    Trash,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct FileChange {
    pub file: FileRef,
    pub directory: bool,
    pub kind: ChangeKind,
    pub name: Option<String>,
    #[serde(default)]
    pub open_files: Vec<FileRef>,
}
#[derive(Clone, Serialize)]
pub struct ReferenceChange {
    pub from: FileRef,
    pub to: Option<FileRef>,
}
#[derive(Clone, Serialize)]
pub struct ChangePreview {
    pub request: FileChange,
    pub location: PathBuf,
    pub affected: Vec<ReferenceChange>,
    pub simulations: Vec<String>,
    pub warnings: Vec<String>,
    pub blocked: Vec<String>,
    pub disk_revision: String,
    #[serde(skip)]
    pub project: ProjectConfig,
}
#[derive(Serialize)]
pub struct FileChangeResult {
    pub workspace: WorkspaceProject,
    pub affected: Vec<ReferenceChange>,
    pub created: Option<FileRef>,
}
#[derive(Serialize)]
pub struct ExplorerLocation {
    pub file: FileRef,
    pub location: PathBuf,
    pub exists: bool,
    pub mutable: bool,
}

// Missing entries must still have an identity so users can remove them.
pub(crate) fn location(workspace: &WorkspaceProject, file: &FileRef) -> Result<PathBuf> {
    reference_location(&workspace.path, &workspace.project, file)
}
fn reference_location(
    config_path: &Path,
    project: &ProjectConfig,
    file: &FileRef,
) -> Result<PathBuf> {
    validate_reference(project, file)?;
    let base = config_path.parent().context("Missing project directory")?;
    let root = match file {
        FileRef::Local(_) => base.to_owned(),
        FileRef::Rooted { root, .. } => base.join(&project.source_roots[root]),
    };
    let root = normalize(&root)?;
    let root = root.canonical().unwrap_or(root);
    Ok(root
        .join(file.path())
        .components()
        .filter(|c| !matches!(c, Component::CurDir))
        .collect())
}
fn normalize(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() {
        bail!("Choose an absolute directory")
    }
    let mut result = PathBuf::new();
    for part in path.components() {
        match part {
            Component::ParentDir => {
                if !result.pop() {
                    bail!("Invalid directory")
                }
            }
            Component::CurDir => {}
            part => result.push(part.as_os_str()),
        }
    }
    Ok(result)
}
fn named(name: &str) -> Result<()> {
    if name.is_empty()
        || name.trim() != name
        || name.contains(['/', '\\'])
        || name.chars().any(char::is_control)
        || !matches!(
            Path::new(name).components().next(),
            Some(Component::Normal(_))
        )
    {
        bail!("Enter a file or folder name without path separators")
    }
    Ok(())
}
fn child(parent: &FileRef, name: &str) -> FileRef {
    match parent {
        FileRef::Local(path) => FileRef::Local(path.join(name)),
        FileRef::Rooted { root, path } => FileRef::Rooted {
            root: root.clone(),
            path: path.join(name),
        },
    }
}
fn no_links(path: &Path) -> Result<()> {
    let mut part = PathBuf::new();
    for component in path.components() {
        part.push(component.as_os_str());
        match fs::symlink_metadata(&part) {
            Ok(meta) if meta.file_type().is_symlink() => bail!(
                "File operations cannot traverse symlinks: {}",
                part.display()
            ),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).with_context(|| format!("Inspect {}", part.display())),
        }
    }
    Ok(())
}
fn protected(workspace: &WorkspaceProject, path: &Path, store: &Path) -> bool {
    let Ok(store) = store.canonical().or_else(|_| std::path::absolute(store)) else {
        return true;
    };
    workspace.path.starts_with(path)
        || path.starts_with(&store)
        || store.starts_with(path)
        || path
            .components()
            .any(|c| c.as_os_str() == ".hdlview" || c.as_os_str() == ".git")
}
fn is_root(workspace: &WorkspaceProject, path: &Path) -> bool {
    path == workspace.path.parent().unwrap_or(Path::new("/"))
        || workspace.project.source_roots.keys().any(|root| {
            location(
                workspace,
                &FileRef::Rooted {
                    root: root.clone(),
                    path: ".".into(),
                },
            )
            .is_ok_and(|p| p == path)
        })
}
pub fn explorer(workspace: &WorkspaceProject, store: &Path) -> Result<Vec<ExplorerLocation>> {
    let mut files = workspace::project_files(&workspace.project);
    files.extend(
        workspace
            .project
            .imports
            .iter()
            .filter(|r| r.kind == "folder")
            .map(|r| r.location.clone()),
    );
    let mut parents = Vec::new();
    for file in &files {
        let mut parent = file.path().parent();
        while let Some(path) = parent {
            if path.as_os_str().is_empty() {
                break;
            }
            parents.push(match file {
                FileRef::Local(_) => FileRef::Local(path.into()),
                FileRef::Rooted { root, .. } => FileRef::Rooted {
                    root: root.clone(),
                    path: path.into(),
                },
            });
            parent = path.parent();
        }
        if let FileRef::Rooted { root, .. } = file {
            parents.push(FileRef::Rooted {
                root: root.clone(),
                path: ".".into(),
            });
        }
    }
    files.extend(parents);
    files.sort();
    files.dedup();
    files
        .into_iter()
        .map(|file| {
            let path = location(workspace, &file)?;
            let mutable = !protected(workspace, &path, store)
                && !is_root(workspace, &path)
                && no_links(&path).is_ok();
            Ok(ExplorerLocation {
                file,
                exists: path.exists(),
                location: path,
                mutable,
            })
        })
        .collect()
}
pub fn create(
    workspace: &WorkspaceProject,
    request: &CreateEntry,
    store: &Path,
) -> Result<FileChangeResult> {
    if workspace.draft_id.is_some() {
        bail!("Finish creating the project first")
    }
    named(&request.name)?;
    let directory = normalize(&request.directory)?;
    no_links(&directory)?;
    let path = directory.join(&request.name);
    if protected(workspace, &path, store) {
        bail!("This location is managed by HDLView or version control")
    }
    if path.exists() {
        bail!("{} already exists; use Add Existing Files", path.display())
    }
    let mut next = workspace.clone();
    // Default rtl/sim parents may not exist yet. Other destinations must be explicitly selected existing directories.
    let base = workspace
        .path
        .parent()
        .context("Missing project directory")?;
    let default_parent = directory == base.join("rtl") || directory == base.join("sim");
    if !directory.exists() && !default_parent {
        bail!("Choose an existing destination directory")
    }
    let parent = if default_parent && !directory.exists() {
        FileRef::Local(directory.strip_prefix(base)?.into())
    } else {
        workspace::register(&directory, &workspace.path, &mut next.project, true)?
    };
    let file = child(&parent, &request.name);
    if request.folder {
        next.project.imports.push(ImportRecord {
            group: request.group,
            kind: "folder".into(),
            location: file.clone(),
            working_directory: None,
            files: Vec::new(),
            exclusions: Vec::new(),
        });
    } else {
        let (language, role) = workspace::language(&path)
            .context("Only .v, .sv, .vh, and .svh files can be created")?;
        match (request.group, role) {
            (SourceGroup::Design, workspace::FileRole::Design) => {
                next.project.sources.push(SourceFile {
                    path: file.clone(),
                    language,
                })
            }
            (SourceGroup::Simulation, workspace::FileRole::Design) => {
                next.project.simulation_sources.push(file.clone())
            }
            (SourceGroup::Design, _) => next.project.headers.push(file.clone()),
            (SourceGroup::Simulation, _) => next.project.simulation_headers.push(file.clone()),
        }
        if matches!(
            workspace::language(&path),
            Some((_, workspace::FileRole::Header))
        ) && !next.project.include_dirs.contains(&parent)
        {
            next.project.include_dirs.push(parent);
        }
    }
    validate_project(&next.project)?;
    let made_parent = !directory.exists();
    if made_parent {
        fs::create_dir(&directory)?
    }
    let result = if request.folder {
        fs::create_dir(&path)
    } else {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map(|_| ())
    };
    if let Err(error) = result {
        if made_parent {
            let _ = fs::remove_dir(&directory);
        }
        return Err(error).with_context(|| format!("Create {}", path.display()));
    }
    Ok(FileChangeResult {
        workspace: next,
        affected: Vec::new(),
        created: Some(file),
    })
}
pub(crate) fn excludes(
    config_path: &Path,
    project: &ProjectConfig,
    exclusion: &ImportExclusion,
    file: &FileRef,
) -> bool {
    match (
        reference_location(config_path, project, &exclusion.path),
        reference_location(config_path, project, file),
    ) {
        (Ok(path), Ok(file)) => file == path || (exclusion.directory && file.starts_with(path)),
        _ => false,
    }
}
fn all_references(project: &ProjectConfig) -> Vec<FileRef> {
    let mut files = workspace::project_files(project);
    files.extend(project.include_dirs.clone());
    for record in &project.imports {
        files.push(record.location.clone());
        files.extend(record.files.clone());
        files.extend(record.exclusions.iter().map(|e| e.path.clone()));
    }
    files.sort();
    files.dedup();
    files
}
fn replace_references(project: &mut ProjectConfig, changes: &BTreeMap<FileRef, Option<FileRef>>) {
    let replace = |files: &mut Vec<FileRef>| {
        *files = files
            .iter()
            .filter_map(|file| {
                changes
                    .get(file)
                    .cloned()
                    .unwrap_or_else(|| Some(file.clone()))
            })
            .collect();
    };
    project
        .sources
        .retain_mut(|source| match changes.get(&source.path) {
            Some(Some(next)) => {
                source.path = next.clone();
                source.language = hdl_language(next.path()).unwrap_or(source.language.clone());
                true
            }
            Some(None) => false,
            None => true,
        });
    replace(&mut project.headers);
    replace(&mut project.simulation_headers);
    replace(&mut project.simulation_sources);
    replace(&mut project.include_dirs);
    replace(&mut project.assets);
    for simulation in project.simulations.values_mut() {
        replace(&mut simulation.testbench);
        replace(&mut simulation.models);
        if let Some(file) = &simulation.sdf {
            if let Some(next) = changes.get(file) {
                simulation.sdf = next.clone();
            }
        }
    }
    if let Some(physical) = &mut project.physical {
        if let Some(file) = &physical.sdc {
            if let Some(next) = changes.get(file) {
                physical.sdc = next.clone();
            }
        }
    }
    project.imports.retain_mut(|record| {
        match changes.get(&record.location) {
            Some(Some(next)) => record.location = next.clone(),
            Some(None) => return false,
            None => {}
        }
        replace(&mut record.files);
        record
            .exclusions
            .retain_mut(|exclusion| match changes.get(&exclusion.path) {
                Some(Some(next)) => {
                    exclusion.path = next.clone();
                    true
                }
                Some(None) => false,
                None => true,
            });
        true
    });
}
fn tree_revision(
    path: &Path,
    registered: &BTreeSet<PathBuf>,
    blocked: &mut Vec<String>,
    cancel: &CancelToken,
) -> Result<String> {
    cancel.check()?;
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok("missing".into()),
        Err(error) => return Err(error).with_context(|| format!("Inspect {}", path.display())),
    };
    if metadata.file_type().is_symlink() {
        blocked.push(format!("Symlink: {}", path.display()));
        return Ok("symlink".into());
    }
    if metadata.is_file() {
        if !registered.contains(path) {
            blocked.push(format!("Unregistered file: {}", path.display()));
        }
        return file_hash(path);
    }
    if !metadata.is_dir() {
        blocked.push(format!("Unsupported entry: {}", path.display()));
        return Ok("special".into());
    }
    let mut entries = fs::read_dir(path)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(|e| e.file_name());
    let mut state = Vec::new();
    for entry in entries {
        state.push((
            entry.file_name(),
            tree_revision(&entry.path(), registered, blocked, cancel)?,
        ));
    }
    Ok(hash(serde_json::to_vec(&state)?))
}
pub fn preview(
    workspace: &WorkspaceProject,
    request: FileChange,
    store: &Path,
    cancel: &CancelToken,
) -> Result<ChangePreview> {
    if workspace.draft_id.is_some() {
        bail!("Finish creating the project first")
    }
    let path = location(workspace, &request.file)?;
    let listed = explorer(workspace, store)?;
    if !listed.iter().any(|e| e.file == request.file) {
        bail!("Entry is not registered in this project")
    }
    let registered_file = workspace::project_files(&workspace.project).contains(&request.file);
    if request.directory == registered_file {
        bail!("Entry type does not match its registered project role")
    }
    if request.kind != ChangeKind::Remove {
        if protected(workspace, &path, store) || is_root(workspace, &path) {
            bail!("This project/root location cannot be renamed or trashed")
        }
        no_links(&path)?;
        let metadata =
            fs::metadata(&path).with_context(|| format!("Missing input {}", path.display()))?;
        if metadata.is_dir() != request.directory {
            bail!("Entry type changed; refresh the explorer")
        }
    }
    let destination = if request.kind == ChangeKind::Rename {
        let name = request.name.as_deref().context("Enter a new name")?;
        named(name)?;
        let destination = path.with_file_name(name);
        if destination == path {
            bail!("Enter a different name")
        }
        if destination.exists() {
            bail!("{} already exists", destination.display())
        }
        if !request.directory
            && workspace::registered_role(&workspace.project, &request.file).is_some()
        {
            let old_header = matches!(
                workspace::language(&path),
                Some((_, workspace::FileRole::Header))
            );
            let (_, role) = workspace::language(&destination)
                .context("Use a Verilog/SystemVerilog extension")?;
            if old_header != (role == workspace::FileRole::Header) {
                bail!("Rename must preserve the source/header role")
            }
        }
        Some(destination)
    } else {
        None
    };
    let mut changes = BTreeMap::new();
    let mut references = all_references(&workspace.project);
    for file in &request.open_files {
        let open = location(workspace, file)?;
        if open == path || (request.directory && open.starts_with(&path)) {
            if !references.contains(file) {
                workspace::document_path(workspace, file)?;
            }
            references.push(file.clone());
        }
    }
    references.sort();
    references.dedup();
    for file in references {
        let original = location(workspace, &file)?;
        if original == path || (request.directory && original.starts_with(&path)) {
            let next = destination
                .as_ref()
                .map(|destination| -> Result<FileRef> {
                    let suffix = original.strip_prefix(&path).unwrap_or(Path::new(""));
                    Ok(match &file {
                        FileRef::Local(_) => FileRef::Local(
                            destination
                                .join(suffix)
                                .strip_prefix(
                                    workspace
                                        .path
                                        .parent()
                                        .context("Missing project directory")?,
                                )?
                                .into(),
                        ),
                        FileRef::Rooted { root, .. } => {
                            let root_path = location(
                                workspace,
                                &FileRef::Rooted {
                                    root: root.clone(),
                                    path: ".".into(),
                                },
                            )?;
                            let root_path = if root_path.starts_with(&path) {
                                destination.join(root_path.strip_prefix(&path)?)
                            } else {
                                root_path
                            };
                            FileRef::Rooted {
                                root: root.clone(),
                                path: destination.join(suffix).strip_prefix(root_path)?.into(),
                            }
                        }
                    })
                })
                .transpose()?;
            changes.insert(file, next);
        }
    }
    let registered: BTreeSet<_> = workspace::project_files(&workspace.project)
        .iter()
        .map(|f| location(workspace, f))
        .collect::<Result<_>>()?;
    let mut blocked = Vec::new();
    let disk_revision = if request.kind == ChangeKind::Remove {
        "membership".into()
    } else {
        tree_revision(&path, &registered, &mut blocked, cancel)?
    };
    let warnings = if request.kind == ChangeKind::Rename {
        vec!["HDL include strings and filelist contents are not rewritten. Folder renaming moves all disk contents.".into()]
    } else {
        Vec::new()
    };
    if request.kind != ChangeKind::Trash {
        blocked.clear();
    }
    #[cfg(not(windows))]
    if request.kind == ChangeKind::Trash && !Path::new("/usr/bin/gio").is_file() {
        blocked.push("System GIO is unavailable; install libglib2.0-bin".into());
    }
    let simulations = workspace
        .project
        .simulations
        .iter()
        .filter(|(_, s)| {
            s.testbench
                .iter()
                .chain(&s.models)
                .chain(&s.sdf)
                .any(|f| changes.contains_key(f))
        })
        .map(|(name, _)| name.clone())
        .collect();
    let mut project = workspace.project.clone();
    if let Some(destination) = &destination {
        for (name, root) in &mut project.source_roots {
            let original = location(
                workspace,
                &FileRef::Rooted {
                    root: name.clone(),
                    path: ".".into(),
                },
            )?;
            if original.starts_with(&path) {
                *root = workspace::relative_directory(
                    workspace
                        .path
                        .parent()
                        .context("Missing project directory")?,
                    &destination.join(original.strip_prefix(&path)?),
                );
            }
        }
        for record in &mut project.imports {
            if let Some(working) = &record.working_directory {
                if working.starts_with(&path) {
                    record.working_directory = Some(destination.join(working.strip_prefix(&path)?));
                }
            }
        }
    }
    replace_references(&mut project, &changes);
    // Exclusions refer to removed originals and must survive reference removal.
    if request.kind != ChangeKind::Rename {
        for record in &mut project.imports {
            if workspace.project.imports.iter().any(|r| {
                r.location == record.location
                    && r.group == record.group
                    && (r.files.iter().any(|f| changes.contains_key(f))
                        || (r.kind == "folder"
                            && location(workspace, &r.location).is_ok_and(|p| path.starts_with(p))))
            }) {
                let exclusion = ImportExclusion {
                    path: request.file.clone(),
                    directory: request.directory,
                };
                if !record.exclusions.contains(&exclusion) {
                    record.exclusions.push(exclusion);
                }
            }
        }
    }
    validate_project(&project)?;
    Ok(ChangePreview {
        request,
        location: path,
        affected: changes
            .into_iter()
            .map(|(from, to)| ReferenceChange { from, to })
            .collect(),
        simulations,
        warnings,
        blocked,
        disk_revision,
        project,
    })
}

pub fn apply(
    workspace: &WorkspaceProject,
    preview: &ChangePreview,
    store: &Path,
    cancel: &CancelToken,
) -> Result<FileChangeResult> {
    let current = self::preview(workspace, preview.request.clone(), store, cancel)?;
    if current.disk_revision != preview.disk_revision {
        bail!("Disk inputs changed; review the operation again")
    }
    if !current.blocked.is_empty() {
        bail!("{}", current.blocked.join("\n"))
    }
    cancel.check()?;
    match current.request.kind {
        ChangeKind::Remove => {}
        ChangeKind::Rename => rename_exclusive(
            &current.location,
            &current
                .location
                .with_file_name(current.request.name.as_deref().context("Missing name")?),
        )?,
        ChangeKind::Trash => trash(&current.location)?,
    }
    let mut next = workspace.clone();
    next.project = current.project;
    Ok(FileChangeResult {
        workspace: next,
        affected: current.affected,
        created: None,
    })
}
#[cfg(not(windows))]
fn trash(path: &Path) -> Result<()> {
    let output = std::process::Command::new("/usr/bin/gio")
        .args(["trash", "--"])
        .arg(path)
        .output()
        .context("Launch system Trash")?;
    if !output.status.success() {
        bail!(
            "Trash failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )
    }
    Ok(())
}
#[cfg(windows)]
fn trash(path: &Path) -> Result<()> {
    trash::delete(path).context("Move to the Recycle Bin")
}
#[cfg(target_os = "linux")]
fn rename_exclusive(from: &Path, to: &Path) -> Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let from = std::ffi::CString::new(from.as_os_str().as_bytes())?;
    let to = std::ffi::CString::new(to.as_os_str().as_bytes())?;
    // Both NUL-terminated paths live through the syscall. NOREPLACE prevents a concurrent destination overwrite.
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result != 0 {
        return Err(std::io::Error::last_os_error()).context("Rename without replacement");
    }
    Ok(())
}
#[cfg(windows)]
fn rename_exclusive(from: &Path, to: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    let wide = |path: &Path| -> Vec<u16> { path.as_os_str().encode_wide().chain([0]).collect() };
    let (from, to) = (wide(from), wide(to));
    // Both NUL-terminated paths live through the call. No flags: an existing destination is an error.
    let moved = unsafe {
        windows_sys::Win32::Storage::FileSystem::MoveFileExW(from.as_ptr(), to.as_ptr(), 0)
    };
    if moved == 0 {
        return Err(std::io::Error::last_os_error()).context("Rename without replacement");
    }
    Ok(())
}
#[cfg(not(any(target_os = "linux", windows)))]
fn rename_exclusive(_from: &Path, _to: &Path) -> Result<()> {
    bail!("File renaming is supported on Linux and Windows")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn project(path: &Path) -> WorkspaceProject {
        workspace::create(&path.join("hdlview.project.json"), "files".into(), false).unwrap()
    }
    fn add(
        workspace: &WorkspaceProject,
        name: &str,
        group: SourceGroup,
        folder: bool,
    ) -> WorkspaceProject {
        create(
            workspace,
            &CreateEntry {
                directory: workspace
                    .path
                    .parent()
                    .unwrap()
                    .join(if group == SourceGroup::Design {
                        "rtl"
                    } else {
                        "sim"
                    }),
                name: name.into(),
                group,
                folder,
            },
            &workspace.path.parent().unwrap().join(".cache"),
        )
        .unwrap()
        .workspace
    }
    fn change(
        workspace: &WorkspaceProject,
        file: &str,
        directory: bool,
        kind: ChangeKind,
        name: Option<&str>,
    ) -> ChangePreview {
        preview(
            workspace,
            FileChange {
                file: file.into(),
                directory,
                kind,
                name: name.map(String::from),
                open_files: Vec::new(),
            },
            &workspace.path.parent().unwrap().join(".cache"),
            &CancelToken::default(),
        )
        .unwrap()
    }
    fn apply_change(
        workspace: &WorkspaceProject,
        preview: &ChangePreview,
    ) -> Result<FileChangeResult> {
        apply(
            workspace,
            preview,
            &workspace.path.parent().unwrap().join(".cache"),
            &CancelToken::default(),
        )
    }
    #[test]
    fn empty_creation_headers_external_roots_and_explicit_save() {
        let directory = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let workspace = project(directory.path());
        let saved = fs::read(&workspace.path).unwrap();
        let workspace = add(&workspace, "empty space ü.sv", SourceGroup::Design, false);
        assert_eq!(
            fs::read(directory.path().join("rtl/empty space ü.sv")).unwrap(),
            b""
        );
        let workspace = add(&workspace, "defs.svh", SourceGroup::Simulation, false);
        assert_eq!(
            workspace.project.simulation_headers,
            vec![FileRef::from("sim/defs.svh")]
        );
        assert!(workspace
            .project
            .include_dirs
            .contains(&FileRef::from("sim")));
        let result = create(
            &workspace,
            &CreateEntry {
                directory: external.path().into(),
                name: "other.v".into(),
                group: SourceGroup::Design,
                folder: false,
            },
            &directory.path().join(".cache"),
        )
        .unwrap();
        assert!(matches!(result.created, Some(FileRef::Rooted { .. })));
        assert_eq!(fs::read(&workspace.path).unwrap(), saved);
        let saved = workspace::save(&result.workspace, &result.workspace.revision).unwrap();
        assert_eq!(saved.project.sources.len(), 2);
        assert!(create(
            &saved,
            &CreateEntry {
                directory: directory.path().join("rtl"),
                name: "empty space ü.sv".into(),
                group: SourceGroup::Design,
                folder: false
            },
            &directory.path().join(".cache")
        )
        .is_err());
    }
    #[test]
    fn invalid_creation_does_not_make_default_directories() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = project(directory.path());
        for name in ["../bad.sv", "bad.vhd", ".", "..", "", "a/b.sv"] {
            assert!(create(
                &workspace,
                &CreateEntry {
                    directory: directory.path().join("rtl"),
                    name: name.into(),
                    group: SourceGroup::Design,
                    folder: false
                },
                &directory.path().join(".cache")
            )
            .is_err());
            assert!(!directory.path().join("rtl").exists());
        }
    }
    #[test]
    fn folder_rename_updates_all_references_and_preserves_order() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = add(
            &project(directory.path()),
            "nested",
            SourceGroup::Design,
            true,
        );
        let mut workspace = create(
            &workspace,
            &CreateEntry {
                directory: directory.path().join("rtl/nested"),
                name: "a.sv".into(),
                group: SourceGroup::Design,
                folder: false,
            },
            &directory.path().join(".cache"),
        )
        .unwrap()
        .workspace;
        workspace = add(&workspace, "b.sv", SourceGroup::Design, false);
        workspace.project.assets.push("rtl/nested/note.txt".into());
        fs::write(directory.path().join("rtl/nested/note.txt"), "auxiliary").unwrap();
        workspace.project.include_dirs.push("rtl/nested".into());
        let preview = change(
            &workspace,
            "rtl/nested",
            true,
            ChangeKind::Rename,
            Some("renamed"),
        );
        let result = apply_change(&workspace, &preview).unwrap();
        assert_eq!(
            result.workspace.project.sources[0].path,
            FileRef::from("rtl/renamed/a.sv")
        );
        assert_eq!(
            result.workspace.project.sources[1].path,
            FileRef::from("rtl/b.sv")
        );
        assert_eq!(
            result.workspace.project.assets,
            vec![FileRef::from("rtl/renamed/note.txt")]
        );
        assert_eq!(
            result.workspace.project.imports[0].location,
            FileRef::from("rtl/renamed")
        );
        assert!(directory.path().join("rtl/renamed/note.txt").exists());
        let stale = change(
            &result.workspace,
            "rtl/renamed/a.sv",
            false,
            ChangeKind::Rename,
            Some("c.sv"),
        );
        fs::write(directory.path().join("rtl/renamed/a.sv"), "external change").unwrap();
        assert!(apply_change(&result.workspace, &stale).is_err());
        assert!(directory.path().join("rtl/renamed/a.sv").exists());
    }
    #[test]
    fn remove_survives_rescan_and_missing_file_removal() {
        let directory = tempfile::tempdir().unwrap();
        let mut workspace = add(
            &project(directory.path()),
            "a.sv",
            SourceGroup::Design,
            false,
        );
        let scan = workspace::preview(
            &workspace,
            &workspace::ImportRequest {
                group: SourceGroup::Design,
                kind: "folder".into(),
                paths: vec![directory.path().join("rtl")],
                working_directory: None,
                record_index: None,
            },
            &CancelToken::default(),
        )
        .unwrap();
        workspace.project = workspace::apply(
            &scan,
            &[workspace::ImportChoice {
                index: 0,
                role: workspace::FileRole::Design,
                selected: true,
            }],
        )
        .unwrap();
        let removed = apply_change(
            &workspace,
            &change(&workspace, "rtl/a.sv", false, ChangeKind::Remove, None),
        )
        .unwrap()
        .workspace;
        assert!(directory.path().join("rtl/a.sv").exists());
        assert!(removed.project.sources.is_empty());
        let removed = workspace::save(&removed, &removed.revision).unwrap();
        let scan = workspace::preview(
            &removed,
            &workspace::ImportRequest {
                group: SourceGroup::Design,
                kind: "folder".into(),
                paths: Vec::new(),
                working_directory: None,
                record_index: Some(0),
            },
            &CancelToken::default(),
        )
        .unwrap();
        assert!(scan.entries[0].excluded);
        let mut readded = removed;
        readded.project = workspace::apply(
            &scan,
            &[workspace::ImportChoice {
                index: 0,
                role: workspace::FileRole::Design,
                selected: true,
            }],
        )
        .unwrap();
        fs::remove_file(directory.path().join("rtl/a.sv")).unwrap();
        assert!(apply_change(
            &readded,
            &change(&readded, "rtl/a.sv", false, ChangeKind::Remove, None)
        )
        .unwrap()
        .workspace
        .project
        .sources
        .is_empty());
    }
    #[test]
    fn folder_trash_blocks_unregistered_and_hidden_files_and_roots() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = add(
            &project(directory.path()),
            "folder",
            SourceGroup::Design,
            true,
        );
        fs::write(directory.path().join("rtl/folder/.hidden"), "keep").unwrap();
        let preview = change(&workspace, "rtl/folder", true, ChangeKind::Trash, None);
        assert!(preview.blocked.iter().any(|p| p.contains(".hidden")));
        assert!(apply_change(&workspace, &preview).is_err());
        assert!(directory.path().join("rtl/folder/.hidden").exists());
        assert!(self::preview(
            &workspace,
            FileChange {
                file: ".".into(),
                directory: true,
                kind: ChangeKind::Trash,
                name: None,
                open_files: Vec::new(),
            },
            &directory.path().join(".cache"),
            &CancelToken::default()
        )
        .is_err());
    }
    #[test]
    fn excluded_directory_reappears_only_through_explicit_import() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = add(
            &project(directory.path()),
            "child",
            SourceGroup::Design,
            true,
        );
        let mut workspace = create(
            &workspace,
            &CreateEntry {
                directory: directory.path().join("rtl/child"),
                name: "a.sv".into(),
                group: SourceGroup::Design,
                folder: false,
            },
            &directory.path().join(".cache"),
        )
        .unwrap()
        .workspace;
        workspace.project.imports.push(ImportRecord {
            group: SourceGroup::Design,
            kind: "folder".into(),
            location: "rtl".into(),
            working_directory: None,
            files: vec!["rtl/child/a.sv".into()],
            exclusions: Vec::new(),
        });
        let removed = apply_change(
            &workspace,
            &change(&workspace, "rtl/child", true, ChangeKind::Remove, None),
        )
        .unwrap()
        .workspace;
        assert_eq!(removed.project.imports.len(), 1);
        assert!(removed.project.imports[0].exclusions[0].directory);
        fs::write(directory.path().join("rtl/child/new.sv"), "").unwrap();
        let scan = workspace::preview(
            &removed,
            &workspace::ImportRequest {
                group: SourceGroup::Design,
                kind: "folder".into(),
                paths: Vec::new(),
                working_directory: None,
                record_index: Some(0),
            },
            &CancelToken::default(),
        )
        .unwrap();
        assert!(scan.entries.iter().all(|entry| entry.excluded));
    }
    #[test]
    fn named_testbench_lists_follow_rename_and_removal_without_losing_settings() {
        let directory = tempfile::tempdir().unwrap();
        let mut workspace = add(
            &project(directory.path()),
            "tb.sv",
            SourceGroup::Simulation,
            false,
        );
        workspace.project.simulations.insert("checks".into(), serde_json::from_value(serde_json::json!({"simulator":"icarus","top":"tb","dut_scope":["tb","dut"],"testbench":["sim/tb.sv"],"args":["+seed=7"],"defines":{"CHECKS":"1"}})).unwrap());
        let preview = change(
            &workspace,
            "sim/tb.sv",
            false,
            ChangeKind::Rename,
            Some("testbench.v"),
        );
        assert_eq!(preview.simulations, vec!["checks"]);
        let renamed = apply_change(&workspace, &preview).unwrap().workspace;
        assert_eq!(
            renamed.project.simulations["checks"].testbench,
            vec![FileRef::from("sim/testbench.v")]
        );
        let removed = apply_change(
            &renamed,
            &change(&renamed, "sim/testbench.v", false, ChangeKind::Remove, None),
        )
        .unwrap()
        .workspace;
        assert!(removed.project.simulations["checks"].testbench.is_empty());
        assert_eq!(removed.project.simulations["checks"].args, vec!["+seed=7"]);
        assert_eq!(removed.project.simulations["checks"].defines["CHECKS"], "1");
        assert!(directory.path().join("sim/testbench.v").exists());
    }
    #[test]
    fn filelist_exclusions_and_unregistration_keep_expanded_sources() {
        let directory = tempfile::tempdir().unwrap();
        let mut workspace = add(
            &project(directory.path()),
            "a.sv",
            SourceGroup::Design,
            false,
        );
        workspace = add(&workspace, "b.sv", SourceGroup::Design, false);
        fs::write(directory.path().join("rtl.f"), "rtl/a.sv\nrtl/b.sv\n").unwrap();
        let request = workspace::ImportRequest {
            group: SourceGroup::Design,
            kind: "filelist".into(),
            paths: vec![directory.path().join("rtl.f")],
            working_directory: None,
            record_index: None,
        };
        let preview = workspace::preview(&workspace, &request, &CancelToken::default()).unwrap();
        workspace.project = workspace::apply(
            &preview,
            &[
                workspace::ImportChoice {
                    index: 0,
                    role: workspace::FileRole::Design,
                    selected: true,
                },
                workspace::ImportChoice {
                    index: 1,
                    role: workspace::FileRole::Design,
                    selected: true,
                },
            ],
        )
        .unwrap();
        workspace = apply_change(
            &workspace,
            &change(&workspace, "rtl/a.sv", false, ChangeKind::Remove, None),
        )
        .unwrap()
        .workspace;
        let scan = workspace::preview(
            &workspace,
            &workspace::ImportRequest {
                record_index: Some(0),
                ..request
            },
            &CancelToken::default(),
        )
        .unwrap();
        assert!(scan.entries[0].excluded);
        assert!(!scan.entries[1].excluded);
        let result = apply_change(
            &workspace,
            &change(&workspace, "rtl.f", false, ChangeKind::Remove, None),
        )
        .unwrap();
        assert!(result.workspace.project.imports.is_empty());
        assert_eq!(
            result.workspace.project.sources[0].path,
            FileRef::from("rtl/b.sv")
        );
        assert!(directory.path().join("rtl.f").exists());
    }
    #[cfg(unix)]
    #[test]
    fn symlinks_cannot_redirect_mutations_and_collisions_do_not_replace_files() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let mut workspace = add(
            &project(directory.path()),
            "a.sv",
            SourceGroup::Design,
            false,
        );
        workspace = add(&workspace, "b.sv", SourceGroup::Design, false);
        fs::write(directory.path().join("rtl/b.sv"), "keep").unwrap();
        assert!(preview(
            &workspace,
            FileChange {
                file: "rtl/a.sv".into(),
                directory: false,
                kind: ChangeKind::Rename,
                name: Some("b.sv".into()),
                open_files: Vec::new(),
            },
            &directory.path().join(".cache"),
            &CancelToken::default()
        )
        .is_err());
        symlink(directory.path().join("rtl"), directory.path().join("link")).unwrap();
        assert!(create(
            &workspace,
            &CreateEntry {
                directory: directory.path().join("link"),
                name: "bad.sv".into(),
                group: SourceGroup::Design,
                folder: false
            },
            &directory.path().join(".cache")
        )
        .is_err());
        assert_eq!(
            fs::read_to_string(directory.path().join("rtl/b.sv")).unwrap(),
            "keep"
        );
    }
    #[test]
    fn folder_rename_maps_open_discovered_headers_without_registering_them() {
        let directory = tempfile::tempdir().unwrap();
        let mut workspace = add(
            &project(directory.path()),
            "top.sv",
            SourceGroup::Design,
            false,
        );
        fs::write(
            directory.path().join("rtl/discovered.svh"),
            "`define WIDTH 4\n",
        )
        .unwrap();
        workspace.project.include_dirs.push("rtl".into());
        let review = preview(
            &workspace,
            FileChange {
                file: "rtl".into(),
                directory: true,
                kind: ChangeKind::Rename,
                name: Some("renamed".into()),
                open_files: vec!["rtl/discovered.svh".into()],
            },
            &directory.path().join(".cache"),
            &CancelToken::default(),
        )
        .unwrap();
        let result = apply_change(&workspace, &review).unwrap();
        assert!(result
            .affected
            .iter()
            .any(|r| r.from == FileRef::from("rtl/discovered.svh")
                && r.to == Some(FileRef::from("renamed/discovered.svh"))));
        assert!(result.workspace.project.headers.is_empty());
        assert_eq!(
            result.workspace.project.include_dirs,
            vec![FileRef::from("renamed")]
        );
    }
}
