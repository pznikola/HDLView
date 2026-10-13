//! Working-project imports and revision-checked editing. Tool inputs remain snapshots.
use crate::{model::*, project::*, runner::CancelToken};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Serialize, Deserialize)]
pub struct WorkspaceProject {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub draft_id: Option<String>,
    pub path: PathBuf,
    pub project: ProjectConfig,
    pub revision: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FileRole {
    Design,
    Header,
    Simulation,
    SimulationHeader,
    Remove,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct ImportEntry {
    pub file: FileRef,
    pub language: Language,
    pub role: FileRole,
    pub missing: bool,
    #[serde(default)]
    pub excluded: bool,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct ImportPreview {
    pub project: ProjectConfig,
    pub entries: Vec<ImportEntry>,
    pub record: Option<ImportRecord>,
    pub warnings: Vec<String>,
    pub replace_record: Option<usize>,
}
#[derive(Deserialize)]
pub struct ImportRequest {
    #[serde(default)]
    pub group: SourceGroup,
    pub kind: String,
    #[serde(default)]
    pub paths: Vec<PathBuf>,
    #[serde(default)]
    pub working_directory: Option<PathBuf>,
    #[serde(default)]
    pub record_index: Option<usize>,
}
#[derive(Deserialize)]
pub struct ImportChoice {
    pub index: usize,
    pub role: FileRole,
    pub selected: bool,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Document {
    pub file: FileRef,
    pub text: String,
    pub revision: String,
    pub bom: bool,
    pub line_ending: String,
}
#[derive(Deserialize)]
pub struct SaveDocument {
    pub file: FileRef,
    pub text: String,
    pub expected_revision: String,
    #[serde(default)]
    pub overwrite: bool,
}
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SaveResult {
    Saved { document: Document },
    Conflict { document: Document },
}

pub fn open(path: &Path) -> Result<WorkspaceProject> {
    let path = path
        .canonical()
        .with_context(|| format!("Open project {}", path.display()))?;
    Ok(WorkspaceProject {
        draft_id: None,
        project: load_project(&path)?,
        revision: file_hash(&path)?,
        path,
    })
}
pub fn draft(path: &Path, name: String, technology: Technology) -> Result<WorkspaceProject> {
    let path = path
        .parent()
        .context("Choose a project directory")?
        .canonical()?
        .join(path.file_name().context("Missing configuration filename")?);
    let project = serde_json::from_value(
        serde_json::json!({"schema_version":PROJECT_SCHEMA,"name":name,"top":"","sources":[],"technology":technology,"standard":"1800-2017"}),
    )?;
    validate_project(&project)?;
    Ok(WorkspaceProject {
        path,
        project,
        revision: String::new(),
        draft_id: None,
    })
}
pub fn publish_draft(
    workspace: &WorkspaceProject,
    overwrite: bool,
    expected_revision: Option<&str>,
) -> Result<WorkspaceProject> {
    validate_project(&workspace.project)?;
    if workspace.path.exists() {
        if !overwrite {
            bail!("File exists; confirm overwrite")
        }
        if expected_revision != Some(file_hash(&workspace.path)?.as_str()) {
            bail!("Project configuration changed before overwrite; review again")
        }
        atomic_json(&workspace.path, &workspace.project)?;
    } else {
        let pending = unique_dir(
            workspace
                .path
                .parent()
                .context("Missing project directory")?,
            ".hdlview-create",
        )?;
        let temporary = pending.join("project.json");
        let publication = (|| -> Result<()> {
            atomic_json(&temporary, &workspace.project)?;
            fs::File::open(&temporary)?.sync_all()?;
            // Linking publishes the complete file without replacing a concurrently created configuration.
            fs::hard_link(&temporary, &workspace.path)?;
            Ok(())
        })();
        let cleanup = fs::remove_dir_all(&pending);
        publication?;
        cleanup.context("Remove temporary project publication directory")?;
    }
    open(&workspace.path)
}
#[cfg(test)]
pub fn create(path: &Path, name: String, overwrite: bool) -> Result<WorkspaceProject> {
    let parent = path
        .parent()
        .context("Choose a project directory")?
        .canonical()?;
    let path = parent.join(path.file_name().context("Missing configuration filename")?);
    let project: ProjectConfig = serde_json::from_value(
        serde_json::json!({"schema_version":PROJECT_SCHEMA,"name":name,"top":"","sources":[],"standard":"1800-2017"}),
    )?;
    validate_project(&project)?;
    let bytes = serde_json::to_vec_pretty(&project)?;
    if overwrite {
        atomic_json(&path, &project)?;
    } else {
        use std::io::Write;
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .with_context(|| {
                format!(
                    "Create {}; choose overwrite explicitly if it exists",
                    path.display()
                )
            })?
            .write_all(&bytes)?;
    }
    open(&path)
}
pub fn save(project: &WorkspaceProject, expected: &str) -> Result<WorkspaceProject> {
    if file_hash(&project.path)? != expected {
        bail!("Project configuration changed outside HDLView; reopen it before saving")
    }
    let mut config = project.project.clone();
    validate_project(&config)?;
    deduplicate_simulation_files(&project.path, &mut config)?;
    atomic_json(&project.path, &config)?;
    open(&project.path)
}
pub(crate) fn relative_directory(base: &Path, path: &Path) -> PathBuf {
    let a: Vec<_> = base.components().collect();
    let b: Vec<_> = path.components().collect();
    let common = a.iter().zip(&b).take_while(|(a, b)| a == b).count();
    let mut result = PathBuf::new();
    for _ in common..a.len() {
        result.push("..");
    }
    for component in &b[common..] {
        result.push(component.as_os_str());
    }
    if result.as_os_str().is_empty() {
        result.push(".");
    }
    result
}
pub(crate) fn register(
    path: &Path,
    config_path: &Path,
    project: &mut ProjectConfig,
    directory: bool,
) -> Result<FileRef> {
    let path = path
        .canonical()
        .with_context(|| format!("Missing input {}", path.display()))?;
    let home = config_path
        .parent()
        .context("Missing project directory")?
        .canonical()?;
    if let Ok(local) = path.strip_prefix(&home) {
        return Ok(FileRef::Local(if local.as_os_str().is_empty() {
            PathBuf::from(".")
        } else {
            local.into()
        }));
    }
    for (name, root) in &project.source_roots {
        let root = home.join(root).canonical()?;
        if let Ok(local) = path.strip_prefix(root) {
            return Ok(FileRef::Rooted {
                root: name.clone(),
                path: if local.as_os_str().is_empty() {
                    ".".into()
                } else {
                    local.into()
                },
            });
        }
    }
    let root = if directory {
        path.clone()
    } else {
        path.parent().context("Missing input directory")?.into()
    };
    let base: String = root
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let base = if base.is_empty() { "rtl".into() } else { base };
    let mut name = base.clone();
    let mut n = 2;
    while project.source_roots.contains_key(&name) {
        name = format!("{base}_{n}");
        n += 1;
    }
    project
        .source_roots
        .insert(name.clone(), relative_directory(&home, &root));
    Ok(FileRef::Rooted {
        root: name,
        path: if directory {
            ".".into()
        } else {
            path.strip_prefix(root)?.into()
        },
    })
}
pub(crate) fn language(path: &Path) -> Option<(Language, FileRole)> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "sv" => Some((Language::SystemVerilog, FileRole::Design)),
        "v" => Some((Language::Verilog, FileRole::Design)),
        "svh" => Some((Language::SystemVerilog, FileRole::Header)),
        "vh" => Some((Language::Verilog, FileRole::Header)),
        _ => None,
    }
}
fn scan(
    directory: &Path,
    files: &mut Vec<PathBuf>,
    warnings: &mut Vec<String>,
    cancel: &CancelToken,
) -> Result<()> {
    cancel.check()?;
    let mut entries = fs::read_dir(directory)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        cancel.check()?;
        let path = entry.path();
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            warnings.push(format!("Skipped symlink {}", path.display()));
            continue;
        }
        if kind.is_dir() {
            if [
                ".git",
                "node_modules",
                "target",
                ".hdlview",
                "dist",
                "__pycache__",
                ".venv",
            ]
            .contains(&entry.file_name().to_string_lossy().as_ref())
            {
                warnings.push(format!("Skipped directory {}", path.display()));
                continue;
            }
            scan(&path, files, warnings, cancel)?;
        } else if kind.is_file() && language(&path).is_some() {
            files.push(path);
        }
    }
    Ok(())
}
#[derive(Clone)]
struct Token {
    value: String,
    line: usize,
}
fn tokenize(text: &str) -> Result<Vec<Token>> {
    let mut chars = text.chars().peekable();
    let mut tokens = Vec::new();
    let mut value = String::new();
    let mut line = 1;
    let mut start = 1;
    let mut quote = None;
    while let Some(c) = chars.next() {
        if let Some(q) = quote {
            if c == q {
                quote = None;
            } else if c == '\\' && chars.peek() == Some(&q) {
                value.push(chars.next().context("Unfinished escape")?);
            } else {
                value.push(c);
            }
            if c == '\n' {
                line += 1;
            }
            continue;
        }
        if c == '\'' || c == '"' {
            if value.is_empty() {
                start = line;
            }
            quote = Some(c);
            continue;
        }
        if c == '#' || (c == '/' && chars.peek() == Some(&'/')) {
            if !value.is_empty() {
                tokens.push(Token {
                    value: std::mem::take(&mut value),
                    line: start,
                });
            }
            for c in chars.by_ref() {
                if c == '\n' {
                    line += 1;
                    break;
                }
            }
            continue;
        }
        if c == '/' && chars.peek() == Some(&'*') {
            chars.next();
            let mut previous = ' ';
            let mut closed = false;
            for c in chars.by_ref() {
                if c == '\n' {
                    line += 1;
                }
                if previous == '*' && c == '/' {
                    closed = true;
                    break;
                }
                previous = c;
            }
            if !closed {
                bail!("Unterminated block comment at line {line}")
            };
            continue;
        }
        if c.is_whitespace() {
            if !value.is_empty() {
                tokens.push(Token {
                    value: std::mem::take(&mut value),
                    line: start,
                });
            }
            if c == '\n' {
                line += 1;
            }
        } else {
            if value.is_empty() {
                start = line;
            }
            value.push(c);
        }
    }
    if quote.is_some() {
        bail!("Unterminated quoted path at line {start}")
    }
    if !value.is_empty() {
        tokens.push(Token { value, line: start });
    }
    Ok(tokens)
}
fn expand(value: &str) -> Result<String> {
    let mut out = String::new();
    let mut chars = value.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '$' {
            out.push(c);
            continue;
        }
        let close = match chars.peek() {
            Some('{') => Some('}'),
            Some('(') => Some(')'),
            _ => None,
        };
        let mut name = String::new();
        if let Some(close) = close {
            chars.next();
            let mut closed = false;
            for c in chars.by_ref() {
                if c == close {
                    closed = true;
                    break;
                }
                name.push(c);
            }
            if !closed {
                bail!("Unterminated environment variable")
            }
        } else {
            while chars
                .peek()
                .is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_')
            {
                name.push(chars.next().context("Invalid variable")?);
            }
        }
        if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            bail!("Invalid environment variable {name:?}")
        }
        out.push_str(
            &std::env::var(&name)
                .with_context(|| format!("Undefined environment variable {name}"))?,
        );
    }
    Ok(out)
}
struct Filelist {
    files: Vec<PathBuf>,
    includes: Vec<PathBuf>,
    defines: BTreeMap<String, String>,
    define_locations: BTreeMap<String, (PathBuf, usize)>,
    lists: Vec<PathBuf>,
}
impl Filelist {
    fn parse(
        &mut self,
        path: &Path,
        working: &Path,
        relative_to_list: bool,
        stack: &mut BTreeSet<PathBuf>,
        cancel: &CancelToken,
    ) -> Result<()> {
        cancel.check()?;
        let path = path
            .canonical()
            .with_context(|| format!("Open filelist {}", path.display()))?;
        if !stack.insert(path.clone()) {
            bail!("Recursive filelist cycle at {}", path.display())
        }
        if stack.len() > 64 {
            bail!("Filelist nesting exceeds 64 levels")
        }
        self.lists.push(path.clone());
        let base = if relative_to_list {
            path.parent().context("Missing list directory")?
        } else {
            working
        };
        let tokens = tokenize(&fs::read_to_string(&path)?)
            .with_context(|| format!("Parse {}", path.display()))?;
        let mut i = 0;
        while i < tokens.len() {
            cancel.check()?;
            let token = &tokens[i];
            let value = expand(&token.value)
                .with_context(|| format!("{}:{}", path.display(), token.line))?;
            let result = (|| -> Result<()> {
                if value == "-f" || value == "-F" {
                    i += 1;
                    let next = tokens.get(i).context("Missing nested filelist argument")?;
                    self.parse(
                        &base.join(expand(&next.value)?),
                        working,
                        value == "-F",
                        stack,
                        cancel,
                    )?;
                } else if let Some(rest) = value.strip_prefix("+incdir+") {
                    for dir in rest.split('+') {
                        if dir.is_empty() {
                            bail!("Empty include directory")
                        };
                        self.includes.push(
                            base.join(dir)
                                .canonical()
                                .with_context(|| format!("Missing include directory {dir}"))?,
                        );
                    }
                } else if let Some(rest) = value.strip_prefix("+define+") {
                    for define in rest.split('+') {
                        let (key, value) = define.split_once('=').unwrap_or((define, "1"));
                        crate::runner::identifier(key)?;
                        if self.defines.get(key).is_some_and(|v| v != value) {
                            bail!("Conflicting define {key}")
                        };
                        self.defines.insert(key.into(), value.into());
                        self.define_locations
                            .insert(key.into(), (path.clone(), token.line));
                    }
                } else if value.starts_with(['-', '+']) {
                    bail!("Unsupported filelist option {value}")
                } else {
                    let file = base
                        .join(&value)
                        .canonical()
                        .with_context(|| format!("Missing source {value}"))?;
                    if language(&file).is_none() {
                        bail!("Unsupported RTL file {value}")
                    };
                    self.files.push(file);
                }
                Ok(())
            })();
            result.with_context(|| format!("{}:{}", path.display(), token.line))?;
            i += 1;
        }
        stack.remove(&path);
        Ok(())
    }
}
pub fn preview(
    workspace: &WorkspaceProject,
    request: &ImportRequest,
    cancel: &CancelToken,
) -> Result<ImportPreview> {
    let mut project = workspace.project.clone();
    let previous = request
        .record_index
        .map(|i| {
            workspace
                .project
                .imports
                .get(i)
                .cloned()
                .context("Unknown import record")
        })
        .transpose()?;
    let locations = if let Some(record) = &previous {
        vec![resolve_reference(
            &workspace.path,
            &workspace.project,
            &record.location,
        )?]
    } else {
        request.paths.clone()
    };
    if locations.is_empty() {
        bail!("Select files, a folder, or a filelist")
    }
    let group = previous.as_ref().map(|r| r.group).unwrap_or(request.group);
    let mut files = Vec::new();
    let mut warnings = Vec::new();
    let mut record = None;
    if request.kind == "folder" {
        if locations.len() != 1 {
            bail!("Select one folder")
        };
        let root = locations[0].canonical()?;
        let location = register(&root, &workspace.path, &mut project, true)?;
        scan(&root, &mut files, &mut warnings, cancel)?;
        record = Some(ImportRecord {
            group,
            kind: "folder".into(),
            location,
            working_directory: None,
            files: Vec::new(),
            exclusions: previous
                .as_ref()
                .map(|r| r.exclusions.clone())
                .unwrap_or_default(),
        });
    } else if request.kind == "filelist" {
        if locations.len() != 1 {
            bail!("Select one filelist")
        };
        let list = locations[0].canonical()?;
        let working = request
            .working_directory
            .clone()
            .or_else(|| previous.as_ref().and_then(|p| p.working_directory.clone()))
            .unwrap_or_else(|| list.parent().unwrap_or(Path::new(".")).into())
            .canonical()?;
        let mut parsed = Filelist {
            files: Vec::new(),
            includes: Vec::new(),
            defines: BTreeMap::new(),
            define_locations: BTreeMap::new(),
            lists: Vec::new(),
        };
        parsed.parse(&list, &working, true, &mut BTreeSet::new(), cancel)?;
        for dir in parsed.includes {
            let reference = register(&dir, &workspace.path, &mut project, true)?;
            if !project.include_dirs.contains(&reference) {
                project.include_dirs.push(reference);
            }
        }
        for (key, value) in parsed.defines {
            if project.defines.get(&key).is_some_and(|v| v != &value) {
                let (list, line) = &parsed.define_locations[&key];
                bail!(
                    "{}:{line}: Conflicting project define {key}",
                    list.display()
                )
            };
            project.defines.insert(key, value);
        }
        for list in &parsed.lists {
            let reference = register(list, &workspace.path, &mut project, false)?;
            if !project.assets.contains(&reference) {
                project.assets.push(reference);
            }
        }
        record = Some(ImportRecord {
            group,
            kind: "filelist".into(),
            location: register(&list, &workspace.path, &mut project, false)?,
            working_directory: Some(working),
            files: Vec::new(),
            exclusions: previous
                .as_ref()
                .map(|r| r.exclusions.clone())
                .unwrap_or_default(),
        });
        files = parsed.files;
    } else if request.kind == "files" {
        files = locations;
    } else {
        bail!("Unsupported import kind")
    }
    let mut entries = Vec::new();
    let mut seen = BTreeSet::new();
    for file in files {
        cancel.check()?;
        let canonical = file.canonical()?;
        if !seen.insert(canonical.clone()) {
            continue;
        }
        let (language, mut role) = language(&canonical).with_context(|| {
            format!(
                "Unsupported RTL file {}; only Verilog/SystemVerilog is supported",
                canonical.display()
            )
        })?;
        role = match (group, role) {
            (SourceGroup::Simulation, FileRole::Header) => FileRole::SimulationHeader,
            (SourceGroup::Simulation, _) => FileRole::Simulation,
            (_, role) => role,
        };
        let reference = register(&canonical, &workspace.path, &mut project, false)?;
        if previous.is_some() {
            role = registered_role(&project, &reference).unwrap_or(role);
        }
        if matches!(role, FileRole::Header | FileRole::SimulationHeader) {
            let dir = register(
                canonical.parent().context("Missing header directory")?,
                &workspace.path,
                &mut project,
                true,
            )?;
            if !project.include_dirs.contains(&dir) {
                project.include_dirs.push(dir);
            }
        }
        entries.push(ImportEntry {
            excluded: registered_role(&project, &reference).is_none()
                && project
                    .imports
                    .iter()
                    .filter(|r| r.group == group)
                    .flat_map(|r| &r.exclusions)
                    .any(|e| {
                        crate::file_management::excludes(&workspace.path, &project, e, &reference)
                    }),
            file: reference,
            language,
            role,
            missing: false,
        });
    }
    if let Some(previous) = previous {
        for file in previous.files {
            if !entries.iter().any(|e| e.file == file) {
                let language = language(file.path())
                    .map(|(l, _)| l)
                    .unwrap_or(Language::SystemVerilog);
                entries.push(ImportEntry {
                    file,
                    language,
                    role: FileRole::Remove,
                    missing: true,
                    excluded: false,
                });
            }
        }
    }
    Ok(ImportPreview {
        project,
        entries,
        record,
        warnings,
        replace_record: request.record_index,
    })
}
pub fn apply(preview: &ImportPreview, choices: &[ImportChoice]) -> Result<ProjectConfig> {
    let mut project = preview.project.clone();
    let mut record = preview.record.clone();
    if let (Some(record), Some(index)) = (&mut record, preview.replace_record) {
        record.files = project
            .imports
            .get(index)
            .context("Unknown import record")?
            .files
            .clone();
    }
    let mut used = BTreeSet::new();
    let mut ordered_choices: Vec<_> = choices.iter().collect();
    ordered_choices.sort_by_key(|choice| choice.index);
    for choice in &ordered_choices {
        if !used.insert(choice.index) {
            bail!("Duplicate import choice")
        }
        let entry = preview
            .entries
            .get(choice.index)
            .context("Unknown import entry")?;
        if !choice.selected {
            if let Some(record) = &mut record {
                if !entry.missing
                    && !record
                        .exclusions
                        .iter()
                        .any(|e| e.path == entry.file && !e.directory)
                {
                    record.exclusions.push(ImportExclusion {
                        path: entry.file.clone(),
                        directory: false,
                    });
                }
            }
            continue;
        }
        if choice.role != FileRole::Remove {
            for import in &mut project.imports {
                import
                    .exclusions
                    .retain(|e| e.path != entry.file || e.directory);
            }
            if let Some(record) = &mut record {
                record
                    .exclusions
                    .retain(|e| e.path != entry.file || e.directory);
            }
        }
        if entry.missing && choice.role != FileRole::Remove {
            bail!("Missing files can only be removed")
        }
        if language(entry.file.path()).is_some_and(|(_, role)| role == FileRole::Header)
            && ![
                FileRole::Header,
                FileRole::SimulationHeader,
                FileRole::Remove,
            ]
            .contains(&choice.role)
        {
            bail!("Headers cannot be standalone compilation units")
        }
        if choice.role != FileRole::Design {
            project.sources.retain(|s| s.path != entry.file);
        }
        if choice.role != FileRole::Header {
            project.headers.retain(|s| s != &entry.file);
        }
        if choice.role != FileRole::SimulationHeader {
            project.simulation_headers.retain(|f| f != &entry.file);
        }
        if choice.role != FileRole::Simulation {
            project.simulation_sources.retain(|s| s != &entry.file);
        }
        if choice.role != FileRole::Simulation {
            for simulation in project.simulations.values_mut() {
                simulation.testbench.retain(|s| s != &entry.file);
            }
        }
        match choice.role {
            FileRole::Design => {
                if !project.sources.iter().any(|s| s.path == entry.file) {
                    project.sources.push(SourceFile {
                        path: entry.file.clone(),
                        language: entry.language.clone(),
                    });
                }
            }
            FileRole::Header => {
                if !project.headers.contains(&entry.file) {
                    project.headers.push(entry.file.clone());
                }
            }
            FileRole::Simulation => {
                if !project.simulation_sources.contains(&entry.file) {
                    project.simulation_sources.push(entry.file.clone());
                }
            }
            FileRole::SimulationHeader => {
                if !project.simulation_headers.contains(&entry.file) {
                    project.simulation_headers.push(entry.file.clone());
                }
            }
            FileRole::Remove => {}
        }
        if let Some(record) = &mut record {
            if choice.role == FileRole::Remove {
                record.files.retain(|f| f != &entry.file);
            } else if !record.files.contains(&entry.file) {
                record.files.push(entry.file.clone());
            }
        }
    }
    if preview.replace_record.is_some() && record.as_ref().is_some_and(|r| r.kind == "filelist") {
        let files: Vec<_> = ordered_choices
            .iter()
            .filter(|c| c.selected && c.role == FileRole::Design)
            .map(|c| &preview.entries[c.index].file)
            .collect();
        let insertion = project
            .sources
            .iter()
            .position(|s| files.contains(&&s.path))
            .unwrap_or(project.sources.len());
        let reordered: Vec<_> = files
            .iter()
            .filter_map(|file| project.sources.iter().find(|s| &s.path == *file).cloned())
            .collect();
        project.sources.retain(|s| !files.contains(&&s.path));
        let insertion = insertion.min(project.sources.len());
        project.sources.splice(insertion..insertion, reordered);
    }
    if preview.replace_record.is_some() && record.as_ref().is_some_and(|r| r.kind == "filelist") {
        let role = FileRole::Simulation;
        let collection = &mut project.simulation_sources;
        {
            let files: Vec<_> = ordered_choices
                .iter()
                .filter(|c| c.selected && c.role == role)
                .map(|c| preview.entries[c.index].file.clone())
                .collect();
            let insertion = collection
                .iter()
                .position(|f| files.contains(f))
                .unwrap_or(collection.len());
            collection.retain(|f| !files.contains(f));
            collection.splice(
                insertion.min(collection.len())..insertion.min(collection.len()),
                files,
            );
        }
    }
    if let Some(record) = record {
        if let Some(index) = preview.replace_record {
            let old = project
                .imports
                .get_mut(index)
                .context("Import record no longer exists")?;
            *old = record;
        } else {
            project.imports.push(record);
        }
    }
    validate_project(&project)?;
    Ok(project)
}
pub fn registered_role(project: &ProjectConfig, file: &FileRef) -> Option<FileRole> {
    if project.sources.iter().any(|s| &s.path == file) {
        return Some(FileRole::Design);
    }
    for (role, files) in [
        (FileRole::Header, &project.headers),
        (FileRole::Simulation, &project.simulation_sources),
        (FileRole::SimulationHeader, &project.simulation_headers),
    ] {
        if files.contains(file) {
            return Some(role);
        }
    }
    project
        .simulations
        .values()
        .find(|s| s.testbench.contains(file))
        .map(|_| FileRole::Simulation)
}
pub fn project_files(project: &ProjectConfig) -> Vec<FileRef> {
    let mut files: Vec<_> = project
        .sources
        .iter()
        .map(|s| s.path.clone())
        .chain(project.headers.clone())
        .chain(project.simulation_sources.clone())
        .chain(project.simulation_headers.clone())
        .chain(project.assets.clone())
        .chain(
            project
                .imports
                .iter()
                .filter(|i| i.kind == "filelist")
                .map(|i| i.location.clone()),
        )
        .collect();
    for simulation in project.simulations.values() {
        files.extend(simulation.testbench.clone());
        files.extend(simulation.models.clone());
        if let Some(sdf) = &simulation.sdf {
            files.push(sdf.clone());
        }
    }
    if let Some(sdc) = project.physical.as_ref().and_then(|p| p.sdc.as_ref()) {
        files.push(sdc.clone());
    }
    files.sort();
    files.dedup();
    files
}
pub(crate) fn document_path(workspace: &WorkspaceProject, file: &FileRef) -> Result<PathBuf> {
    let path = resolve_reference(&workspace.path, &workspace.project, file)?;
    if !project_files(&workspace.project).contains(file) {
        // Compiler-discovered headers may be opened only inside registered include/source directories.
        validate_hdl(file, true)?;
        let mut directories = Vec::new();
        for directory in &workspace.project.include_dirs {
            directories.push(resolve_reference(
                &workspace.path,
                &workspace.project,
                directory,
            )?);
        }
        for source in workspace
            .project
            .sources
            .iter()
            .map(|s| &s.path)
            .chain(&workspace.project.simulation_sources)
        {
            let source = resolve_reference(&workspace.path, &workspace.project, source)?;
            if let Some(parent) = source.parent() {
                directories.push(parent.to_owned());
            }
        }
        if !directories
            .iter()
            .any(|directory| path.starts_with(directory))
        {
            bail!("File is not registered in the open project")
        }
    }
    Ok(path)
}
pub fn read_document(workspace: &WorkspaceProject, file: &FileRef) -> Result<Document> {
    let path = document_path(workspace, file)?;
    let bytes = fs::read(&path).with_context(|| format!("Read {}", path.display()))?;
    let bom = bytes.starts_with(&[0xef, 0xbb, 0xbf]);
    let text = std::str::from_utf8(if bom { &bytes[3..] } else { &bytes })
        .context("Editor supports UTF-8 text only")?;
    if text.contains('\0') {
        bail!("Binary files cannot be edited")
    }
    if text.replace("\r\n", "").contains('\r') {
        bail!("Unsupported CR-only line endings in {}", path.display())
    }
    let line_ending = if text.contains("\r\n") {
        if text.replace("\r\n", "").contains('\n') {
            bail!("Mixed line endings cannot be edited without normalization")
        };
        "crlf"
    } else {
        "lf"
    };
    Ok(Document {
        file: file.clone(),
        text: text.replace("\r\n", "\n"),
        revision: hash(&bytes),
        bom,
        line_ending: line_ending.into(),
    })
}
pub fn save_document(workspace: &WorkspaceProject, request: &SaveDocument) -> Result<SaveResult> {
    let current = read_document(workspace, &request.file)?;
    if current.revision != request.expected_revision && !request.overwrite {
        return Ok(SaveResult::Conflict { document: current });
    }
    let path = document_path(workspace, &request.file)?;
    let permissions = fs::metadata(&path)?.permissions();
    if permissions.readonly() {
        bail!("File is read-only: {}", path.display())
    }
    let text = if current.line_ending == "crlf" {
        request.text.replace("\r\n", "\n").replace('\n', "\r\n")
    } else {
        request.text.clone()
    };
    let mut bytes = if current.bom {
        vec![0xef, 0xbb, 0xbf]
    } else {
        Vec::new()
    };
    bytes.extend(text.as_bytes());
    let tmp = path.with_file_name(format!(
        ".hdlview-save-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos()
    ));
    let result = (|| -> Result<()> {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        file.set_permissions(permissions)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&tmp, &path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.with_context(|| format!("Save {}", path.display()))?;
    Ok(SaveResult::Saved {
        document: read_document(workspace, &request.file)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn empty(directory: &Path) -> WorkspaceProject {
        create(
            &directory.join("hdlview.project.json"),
            "Test".into(),
            false,
        )
        .unwrap()
    }
    fn choices(preview: &ImportPreview) -> Vec<ImportChoice> {
        preview
            .entries
            .iter()
            .enumerate()
            .map(|(index, e)| ImportChoice {
                index,
                role: e.role.clone(),
                selected: true,
            })
            .collect()
    }
    #[test]
    fn bundled_projects_are_stored_exactly_as_saved() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let mut checked = 0;
        for group in ["examples", "tests/fixtures"] {
            for entry in fs::read_dir(root.join(group)).unwrap() {
                let path = entry.unwrap().path().join("hdlview.project.json");
                if !path.exists() {
                    continue;
                }
                let project = open(&path).unwrap().project;
                assert_eq!(
                    String::from_utf8(serde_json::to_vec_pretty(&project).unwrap()).unwrap(),
                    fs::read_to_string(&path).unwrap(),
                    "{} would change when saved unchanged; save it in HDLView",
                    path.display()
                );
                checked += 1;
            }
        }
        assert!(checked > 18);
    }
    #[test]
    fn an_empty_project_is_valid_but_cannot_be_built() {
        let d = tempfile::tempdir().unwrap();
        let empty = empty(d.path());
        assert!(validate_project(&empty.project).is_ok());
        assert!(validate_build(&empty.project).is_err());
        assert!(create(&empty.path, "Overwrite".into(), false).is_err());
    }
    #[test]
    fn folder_roots_headers_and_immutable_capture() {
        let d = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        fs::create_dir_all(external.path().join("block")).unwrap();
        fs::create_dir(external.path().join("target")).unwrap();
        fs::write(external.path().join("block/top.sv"), "old").unwrap();
        fs::write(external.path().join("block/defs.svh"), "`define WIDTH 4").unwrap();
        fs::write(external.path().join("target/ignored.sv"), "").unwrap();
        let mut workspace = empty(d.path());
        let preview = preview(
            &workspace,
            &ImportRequest {
                group: SourceGroup::Design,
                kind: "folder".into(),
                paths: vec![external.path().into()],
                working_directory: None,
                record_index: None,
            },
            &CancelToken::default(),
        )
        .unwrap();
        assert_eq!(preview.entries.len(), 2);
        assert_eq!(preview.warnings.len(), 1);
        workspace.project = apply(&preview, &choices(&preview)).unwrap();
        workspace.project.top = "top".into();
        assert_eq!(workspace.project.sources.len(), 1);
        assert_eq!(workspace.project.headers.len(), 1);
        let captured = capture(&workspace.path, &workspace.project, out.path()).unwrap();
        let source = &captured.project.sources[0].path;
        assert!(source.path().to_string_lossy().contains("block/top.sv"));
        assert!(captured.project.source_roots.is_empty());
        fs::write(external.path().join("block/top.sv"), "new").unwrap();
        assert_eq!(
            fs::read_to_string(out.path().join("inputs").join(source)).unwrap(),
            "old"
        );
    }
    #[test]
    fn duplicate_roots_and_auxiliary_references_capture_without_collisions() {
        let d = tempfile::tempdir().unwrap();
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        fs::create_dir(a.path().join("rtl")).unwrap();
        fs::create_dir(b.path().join("rtl")).unwrap();
        for (root, text) in [
            (a.path(), "module first; endmodule"),
            (b.path(), "module second; endmodule"),
        ] {
            fs::write(root.join("rtl/top.sv"), text).unwrap();
        }
        let mut workspace = empty(d.path());
        for root in [a.path(), b.path()] {
            let preview = preview(
                &workspace,
                &ImportRequest {
                    group: SourceGroup::Design,
                    kind: "folder".into(),
                    paths: vec![root.join("rtl")],
                    working_directory: None,
                    record_index: None,
                },
                &CancelToken::default(),
            )
            .unwrap();
            workspace.project = apply(&preview, &choices(&preview)).unwrap();
        }
        assert_eq!(workspace.project.source_roots.len(), 2);
        assert_ne!(
            workspace.project.sources[0].path,
            workspace.project.sources[1].path
        );
        let (root, _) = workspace.project.source_roots.first_key_value().unwrap();
        let root = root.clone();
        let original = resolve_reference(
            &workspace.path,
            &workspace.project,
            &FileRef::Rooted {
                root: root.clone(),
                path: ".".into(),
            },
        )
        .unwrap();
        for name in ["tb.sv", "model.v", "delay.sdf", "clock.sdc"] {
            fs::write(original.join(name), name).unwrap();
        }
        let reference = |path: &str| FileRef::Rooted {
            root: root.clone(),
            path: path.into(),
        };
        workspace.project.simulations.insert("gates".into(), serde_json::from_value(serde_json::json!({"simulator":"icarus","top":"tb","dut_scope":["tb","dut"],"testbench":[reference("tb.sv")],"models":[reference("model.v")],"sdf":reference("delay.sdf")})).unwrap());
        workspace.project.physical = Some(serde_json::from_value(serde_json::json!({"pdk":"sky130A","library":"sky130_fd_sc_hd","clock_port":"clk","clock_period_ns":10.0,"sdc":reference("clock.sdc")})).unwrap());
        let captured = capture(&workspace.path, &workspace.project, out.path()).unwrap();
        for source in &captured.project.sources {
            assert!(out.path().join("inputs").join(&source.path).exists());
        }
        let sim = &captured.project.simulations["gates"];
        for path in sim
            .testbench
            .iter()
            .chain(&sim.models)
            .chain(&sim.sdf)
            .chain(&captured.project.physical.as_ref().unwrap().sdc)
        {
            assert!(out.path().join("inputs").join(path).exists());
            assert_eq!(
                captured.origins[&path.path().to_string_lossy().into_owned()],
                original.join(path.path().file_name().unwrap())
            );
        }
        let escaped = FileRef::Rooted {
            root,
            path: "../escape.sv".into(),
        };
        assert!(resolve_reference(&workspace.path, &workspace.project, &escaped).is_err());
    }
    #[test]
    fn rescan_retains_roles_and_unselected_missing_membership() {
        let d = tempfile::tempdir().unwrap();
        let mut workspace = empty(d.path());
        fs::write(d.path().join("tb.sv"), "").unwrap();
        let request = ImportRequest {
            group: SourceGroup::Design,
            kind: "folder".into(),
            paths: vec![d.path().into()],
            working_directory: None,
            record_index: None,
        };
        let initial = preview(&workspace, &request, &CancelToken::default()).unwrap();
        workspace.project = apply(
            &initial,
            &[ImportChoice {
                index: 0,
                role: FileRole::Simulation,
                selected: true,
            }],
        )
        .unwrap();
        let request = ImportRequest {
            group: SourceGroup::Design,
            record_index: Some(0),
            ..request
        };
        let next = preview(&workspace, &request, &CancelToken::default()).unwrap();
        assert!(next.entries[0].role == FileRole::Simulation);
        fs::remove_file(d.path().join("tb.sv")).unwrap();
        let missing = preview(&workspace, &request, &CancelToken::default()).unwrap();
        let mut excluded = choices(&missing);
        excluded[0].selected = false;
        workspace.project = apply(&missing, &excluded).unwrap();
        assert_eq!(workspace.project.imports[0].files.len(), 1);
        assert_eq!(workspace.project.simulation_sources.len(), 1);
        assert!(
            preview(&workspace, &request, &CancelToken::default())
                .unwrap()
                .entries[0]
                .missing
        );
    }
    #[test]
    fn filelist_order_nested_paths_options_and_quotes() {
        let d = tempfile::tempdir().unwrap();
        let mut workspace = empty(d.path());
        fs::create_dir(d.path().join("lists")).unwrap();
        fs::create_dir(d.path().join("include")).unwrap();
        for file in [
            "package.sv",
            "top with space.sv",
            "first.sv",
            "lists/local.sv",
        ] {
            fs::write(d.path().join(file), "").unwrap();
        }
        fs::write(d.path().join("lists/nested.f"), "local.sv\n-f from_cwd.f").unwrap();
        fs::write(d.path().join("lists/from_cwd.f"), "first.sv").unwrap();
        fs::write(d.path().join("rtl.f"),"// order matters\npackage.sv\n-F lists/nested.f\n\"top with space.sv\"\n+incdir+include\n+define+WIDTH=4 /* comment */").unwrap();
        let preview = preview(
            &workspace,
            &ImportRequest {
                group: SourceGroup::Design,
                kind: "filelist".into(),
                paths: vec![d.path().join("rtl.f")],
                working_directory: None,
                record_index: None,
            },
            &CancelToken::default(),
        )
        .unwrap();
        workspace.project = apply(&preview, &choices(&preview)).unwrap();
        assert_eq!(
            workspace
                .project
                .sources
                .iter()
                .map(|s| s.path.path().to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            vec![
                "package.sv",
                "lists/local.sv",
                "first.sv",
                "top with space.sv"
            ]
        );
        assert_eq!(workspace.project.defines["WIDTH"], "4");
        assert_eq!(workspace.project.include_dirs.len(), 1);
        fs::write(
            d.path().join("rtl.f"),
            "\"top with space.sv\"\npackage.sv\n",
        )
        .unwrap();
        let reimported = super::preview(
            &workspace,
            &ImportRequest {
                group: SourceGroup::Design,
                kind: "filelist".into(),
                paths: vec![],
                working_directory: None,
                record_index: Some(0),
            },
            &CancelToken::default(),
        )
        .unwrap();
        workspace.project = apply(&reimported, &choices(&reimported)).unwrap();
        assert_eq!(
            workspace.project.sources[0].path.path(),
            Path::new("top with space.sv")
        );
        assert_eq!(
            workspace.project.sources[1].language,
            Language::SystemVerilog
        );
    }
    #[test]
    fn failed_filelists_preserve_project_and_report_locations() {
        let d = tempfile::tempdir().unwrap();
        let workspace = empty(d.path());
        let request = ImportRequest {
            group: SourceGroup::Design,
            kind: "filelist".into(),
            paths: vec![d.path().join("bad.f")],
            working_directory: None,
            record_index: None,
        };
        for text in [
            "-F bad.f",
            "--unknown thing",
            "$HDLVIEW_UNDEFINED_TEST_VARIABLE/top.sv",
            "+define+X=1\n+define+X=2",
            "missing.sv",
        ] {
            fs::write(&request.paths[0], text).unwrap();
            let error = preview(&workspace, &request, &CancelToken::default())
                .err()
                .unwrap();
            assert!(format!("{error:#}").contains("bad.f"));
            assert!(workspace.project.sources.is_empty());
        }
        assert_eq!(expand("${PATH}").unwrap(), std::env::var("PATH").unwrap());
        assert_eq!(expand("$(PATH)").unwrap(), std::env::var("PATH").unwrap());
        assert!(expand("$(touch /tmp/should-not-exist)").is_err());
        let mut conflicting = workspace.clone();
        conflicting
            .project
            .defines
            .insert("X".into(), "original".into());
        fs::write(&request.paths[0], "+define+X=changed").unwrap();
        let error = preview(&conflicting, &request, &CancelToken::default())
            .err()
            .unwrap();
        assert!(format!("{error:#}").contains("bad.f:1: Conflicting project define"));
    }
    #[test]
    fn order_roles_rescan_and_non_destructive_removal() {
        let d = tempfile::tempdir().unwrap();
        let mut workspace = empty(d.path());
        fs::write(d.path().join("a.sv"), "").unwrap();
        fs::write(d.path().join("b.sv"), "").unwrap();
        let request = ImportRequest {
            group: SourceGroup::Design,
            kind: "folder".into(),
            paths: vec![d.path().into()],
            working_directory: None,
            record_index: None,
        };
        let first = preview(&workspace, &request, &CancelToken::default()).unwrap();
        workspace.project = apply(&first, &choices(&first)).unwrap();
        workspace.project.sources.reverse();
        assert_eq!(workspace.project.sources[0].path.path(), Path::new("b.sv"));
        fs::remove_file(d.path().join("a.sv")).unwrap();
        fs::write(d.path().join("c.sv"), "").unwrap();
        let next = preview(
            &workspace,
            &ImportRequest {
                group: SourceGroup::Design,
                record_index: Some(0),
                ..request
            },
            &CancelToken::default(),
        )
        .unwrap();
        assert!(next.entries.iter().any(|e| e.missing));
        workspace.project = apply(&next, &choices(&next)).unwrap();
        assert_eq!(workspace.project.sources.len(), 2);
        assert_eq!(workspace.project.sources[0].path.path(), Path::new("b.sv"));
        assert!(d.path().join("b.sv").exists());
        fs::write(d.path().join("gate_tb.sv"), "").unwrap();
        let gates = preview(
            &workspace,
            &ImportRequest {
                group: SourceGroup::Simulation,
                kind: "files".into(),
                paths: vec![d.path().join("gate_tb.sv")],
                working_directory: None,
                record_index: None,
            },
            &CancelToken::default(),
        )
        .unwrap();
        workspace.project = apply(
            &gates,
            &[ImportChoice {
                index: 0,
                role: FileRole::Simulation,
                selected: true,
            }],
        )
        .unwrap();
        assert_eq!(workspace.project.simulation_sources.len(), 1);
    }
    #[test]
    fn editor_conflicts_bom_crlf_permissions_and_membership() {
        let d = tempfile::tempdir().unwrap();
        let mut workspace = empty(d.path());
        fs::write(
            d.path().join("top.sv"),
            b"\xef\xbb\xbfmodule top;\r\nendmodule\r\n",
        )
        .unwrap();
        workspace.project.sources.push(SourceFile {
            path: "top.sv".into(),
            language: Language::SystemVerilog,
        });
        let document = read_document(&workspace, &"top.sv".into()).unwrap();
        assert!(document.bom);
        assert_eq!(document.line_ending, "crlf");
        let request = SaveDocument {
            file: document.file,
            text: "module changed;\nendmodule\n".into(),
            expected_revision: document.revision,
            overwrite: false,
        };
        assert!(matches!(
            save_document(&workspace, &request).unwrap(),
            SaveResult::Saved { .. }
        ));
        assert_eq!(
            fs::read(d.path().join("top.sv")).unwrap(),
            b"\xef\xbb\xbfmodule changed;\r\nendmodule\r\n"
        );
        assert!(matches!(
            save_document(&workspace, &request).unwrap(),
            SaveResult::Conflict { .. }
        ));
        fs::write(d.path().join("secret.sv"), "module secret; endmodule\n").unwrap();
        assert!(read_document(&workspace, &"secret.sv".into()).is_err());
        fs::write(d.path().join("included.svh"), "`define INCLUDED 1\n").unwrap();
        assert!(read_document(&workspace, &"included.svh".into()).is_ok());
        let mut permissions = fs::metadata(d.path().join("top.sv")).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(d.path().join("top.sv"), permissions).unwrap();
        assert!(save_document(
            &workspace,
            &SaveDocument {
                overwrite: true,
                ..request
            }
        )
        .is_err());
    }
    #[cfg(unix)]
    #[test]
    fn scanner_skips_symlinks_and_capture_rejects_escape() {
        use std::os::unix::fs::symlink;
        let d = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        fs::write(external.path().join("escape.sv"), "").unwrap();
        symlink(external.path().join("escape.sv"), d.path().join("link.sv")).unwrap();
        symlink(d.path(), d.path().join("cycle")).unwrap();
        let workspace = empty(d.path());
        let scan = preview(
            &workspace,
            &ImportRequest {
                group: SourceGroup::Design,
                kind: "folder".into(),
                paths: vec![d.path().into()],
                working_directory: None,
                record_index: None,
            },
            &CancelToken::default(),
        )
        .unwrap();
        assert!(scan.entries.is_empty());
        assert_eq!(scan.warnings.len(), 2);
        let mut included = workspace.project.clone();
        included.include_dirs.push(".".into());
        let captured = capture(&workspace.path, &included, out.path()).unwrap();
        assert_eq!(captured.hashes.len(), 1);
        assert!(captured.hashes.keys().all(|key| !key.starts_with("./")));
        let mut project = workspace.project;
        project.sources.push(SourceFile {
            path: "link.sv".into(),
            language: Language::SystemVerilog,
        });
        assert!(capture(&workspace.path, &project, out.path()).is_err());
        let cancelled = CancelToken::default();
        cancelled.cancel();
        assert!(preview(
            &WorkspaceProject {
                draft_id: None,
                path: workspace.path,
                project,
                revision: workspace.revision
            },
            &ImportRequest {
                group: SourceGroup::Design,
                kind: "folder".into(),
                paths: vec![d.path().into()],
                working_directory: None,
                record_index: None
            },
            &cancelled
        )
        .is_err());
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    #[test]
    fn draft_creation_and_cancel_do_not_write_and_overwrite_checks_revision() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("hdlview.project.json");
        let draft = draft(&path, "New".into(), Technology::IhpSg13g2).unwrap();
        assert!(!path.exists());
        fs::write(&path, "existing").unwrap();
        assert!(publish_draft(&draft, false, None).is_err());
        assert!(publish_draft(&draft, true, Some("wrong revision")).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "existing");
        let revision = file_hash(&path).unwrap();
        let created = publish_draft(&draft, true, Some(&revision)).unwrap();
        assert_eq!(created.project.technology, Some(Technology::IhpSg13g2));
        assert!(created.project.sources.is_empty());
    }
    #[test]
    fn unsupported_hdl_is_rejected_transactionally_in_both_groups() {
        let d = tempfile::tempdir().unwrap();
        let workspace = create(&d.path().join("hdlview.project.json"), "SV".into(), false).unwrap();
        fs::write(d.path().join("design.vhd"), "entity design is end;").unwrap();
        fs::write(d.path().join("top.sv"), "module top; endmodule").unwrap();
        fs::write(d.path().join("defs.svh"), "// header").unwrap();
        fs::write(d.path().join("mixed.f"), "top.sv\ndesign.vhd\n").unwrap();
        let before = serde_json::to_value(&workspace.project).unwrap();
        for group in [SourceGroup::Design, SourceGroup::Simulation] {
            for (kind, file) in [("files", "design.vhd"), ("filelist", "mixed.f")] {
                let request = ImportRequest {
                    group,
                    kind: kind.into(),
                    paths: vec![d.path().join(file)],
                    working_directory: None,
                    record_index: None,
                };
                let error = format!(
                    "{:#}",
                    preview(&workspace, &request, &CancelToken::default())
                        .err()
                        .unwrap()
                );
                assert!(error.contains(file));
                if kind == "filelist" {
                    assert!(error.contains("mixed.f:2"));
                }
                assert_eq!(serde_json::to_value(&workspace.project).unwrap(), before);
            }
            let request = ImportRequest {
                group,
                kind: "folder".into(),
                paths: vec![d.path().into()],
                working_directory: None,
                record_index: None,
            };
            let scanned = preview(&workspace, &request, &CancelToken::default()).unwrap();
            assert_eq!(scanned.entries.len(), 2);
            let choices: Vec<_> = scanned
                .entries
                .iter()
                .enumerate()
                .map(|(index, e)| ImportChoice {
                    index,
                    role: e.role.clone(),
                    selected: true,
                })
                .collect();
            let imported = apply(&scanned, &choices).unwrap();
            if group == SourceGroup::Simulation {
                assert_eq!(imported.simulation_sources.len(), 1);
                assert_eq!(imported.simulation_headers.len(), 1);
            } else {
                assert_eq!(imported.sources.len(), 1);
                assert_eq!(imported.headers.len(), 1);
            }
        }
        let mut invalid = workspace.project;
        invalid.simulation_sources.push("design.vhd".into());
        assert!(validate_project(&invalid).is_err());
    }
}
