use crate::{
    editor_lint, file_management, masks, model::*, pipeline, project::*, runner::*, simulation,
    solid, waveform, waveprocess::WaveProcess, workspace,
};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Serialize, Deserialize)]
pub struct Job {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub result: Option<Value>,
    pub error: Option<String>,
}
struct State {
    projects: BTreeMap<String, workspace::WorkspaceProject>,
    previews: BTreeMap<String, (String, String, workspace::ImportPreview)>,
    file_previews: BTreeMap<String, (String, String, file_management::ChangePreview)>,
    snapshots: BTreeMap<String, Arc<DesignSnapshot>>,
    // One immutable physical artifact, shared by outline and layer requests.
    layout_cache: Option<(String, Arc<Value>)>,
    layout_generation: u64,
    runs: BTreeMap<String, SimulationRun>,
    waves: BTreeMap<String, Wave>,
    jobs: BTreeMap<String, (Job, CancelToken)>,
}
/// A waveform has its own lock: a slow query must not stall every other request.
#[derive(Clone)]
struct Wave {
    info: Arc<WaveInfo>,
    process: Arc<Mutex<WaveProcess>>,
}
#[derive(Clone)]
pub struct Service {
    state: Arc<Mutex<State>>,
    pub store: PathBuf,
    mutations: Arc<Mutex<()>>,
}
impl Service {
    pub fn new(store: PathBuf) -> Self {
        Self {
            store,
            mutations: Arc::new(Mutex::new(())),
            state: Arc::new(Mutex::new(State {
                projects: BTreeMap::new(),
                previews: BTreeMap::new(),
                file_previews: BTreeMap::new(),
                snapshots: BTreeMap::new(),
                layout_cache: None,
                layout_generation: 0,
                runs: BTreeMap::new(),
                waves: BTreeMap::new(),
                jobs: BTreeMap::new(),
            })),
        }
    }
    fn working_project(&self, path: &str) -> Result<workspace::WorkspaceProject> {
        self.state
            .lock()
            .unwrap()
            .projects
            .get(path)
            .cloned()
            .context("Open the project first")
    }
    fn snapshot(&self, id: &str) -> Result<Arc<DesignSnapshot>> {
        self.state
            .lock()
            .unwrap()
            .snapshots
            .get(id)
            .cloned()
            .context("Open a snapshot first")
    }
    fn remember_snapshot(&self, snapshot: Arc<DesignSnapshot>) {
        let mut state = self.state.lock().unwrap();
        state.layout_cache = None;
        state.layout_generation += 1;
        state.snapshots.insert(snapshot.id.clone(), snapshot);
    }
    fn physical_layout(&self, snapshot: &DesignSnapshot) -> Result<Arc<Value>> {
        let path = snapshot
            .physical_run
            .as_ref()
            .and_then(|run| run.layout.as_ref())
            .context("This snapshot has no layout")?;
        let generation = {
            let state = self.state.lock().unwrap();
            if let Some((id, layout)) = &state.layout_cache {
                if id == &snapshot.id {
                    return Ok(layout.clone());
                }
            }
            state.layout_generation
        };
        let layout = Arc::new(read_json::<Value>(path)?);
        let mut state = self.state.lock().unwrap();
        // A read finishing after close/open must not repopulate the previous session.
        if state.layout_generation == generation
            && state
                .snapshots
                .get(&snapshot.id)
                .is_some_and(|current| std::ptr::eq(current.as_ref(), snapshot))
        {
            state.layout_cache = Some((snapshot.id.clone(), layout.clone()));
        }
        Ok(layout)
    }
    fn launch<F>(&self, kind: &str, f: F) -> Result<Value>
    where
        F: FnOnce(CancelToken) -> Result<Value> + Send + 'static,
    {
        let id = format!(
            "job-{}",
            SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
        );
        let job = Job {
            id: id.clone(),
            kind: kind.into(),
            status: "running".into(),
            result: None,
            error: None,
        };
        let token = CancelToken::default();
        {
            let mut state = self.state.lock().unwrap();
            // A finished job's result is read before the next one of its kind starts.
            state
                .jobs
                .retain(|_, (job, _)| job.kind != kind || job.status == "running");
            if kind == "lint" {
                if state.jobs.values().any(|(job, _)| job.status == "running") {
                    bail!("Linting paused while another job finishes")
                }
            } else {
                for (job, cancel) in state.jobs.values() {
                    if job.kind == "lint" {
                        cancel.cancel();
                    }
                }
            }
            state.jobs.insert(id.clone(), (job.clone(), token.clone()));
        }
        let state = self.state.clone();
        thread::spawn(move || {
            let result =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(token.clone())));
            let mut s = state.lock().unwrap();
            let Some((j, _)) = s.jobs.get_mut(&id) else {
                return;
            };
            match result {
                Ok(Ok(value)) => {
                    j.status = "complete".into();
                    j.result = Some(value)
                }
                Ok(Err(e)) => {
                    j.status = if token.check().is_err() {
                        "cancelled"
                    } else {
                        "failed"
                    }
                    .into();
                    j.error = Some(format!("{e:#}"));
                }
                Err(_) => {
                    j.status = "failed".into();
                    j.error=Some("Worker failed unexpectedly; retained artifacts may contain diagnostic logs".into());
                }
            }
        });
        Ok(serde_json::to_value(job)?)
    }
    fn register_run(&self, run: SimulationRun, cancel: CancelToken) -> Result<Value> {
        let wave = WaveProcess::open(&run.trace, &cancel)?;
        if !wave
            .info
            .variables
            .iter()
            .any(|v| v.path.starts_with(&run.dut_scope))
        {
            bail!("No variables under the configured DUT scope")
        }
        cancel.check()?;
        let mut s = self.state.lock().unwrap();
        s.waves.clear();
        s.waves.insert(
            run.id.clone(),
            Wave {
                info: Arc::new(wave.info.clone()),
                process: Arc::new(Mutex::new(wave)),
            },
        );
        s.runs.insert(run.id.clone(), run.clone());
        Ok(serde_json::to_value(run)?)
    }
    pub fn request(&self, action: &str, v: Value) -> Result<Value> {
        // Serialize mutations and job starts separately from the short-lived state lock.
        let _mutation = if matches!(
            action,
            "open_project"
                | "close_project"
                | "create_project_draft"
                | "publish_project_draft"
                | "update_project"
                | "save_project"
                | "save_document"
                | "apply_import"
                | "create_file_entry"
                | "preview_file_change"
                | "apply_file_change"
                | "build"
                | "simulate"
                | "preview_import"
        ) {
            Some(self.mutations.lock().unwrap())
        } else {
            None
        };
        if matches!(
            action,
            "create_file_entry"
                | "open_project"
                | "create_project_draft"
                | "publish_project_draft"
                | "preview_file_change"
                | "apply_file_change"
                | "update_project"
                | "save_project"
                | "save_document"
                | "apply_import"
                | "close_project"
                | "build"
                | "simulate"
                | "preview_import"
        ) && self
            .state
            .lock()
            .unwrap()
            .jobs
            .values()
            .any(|(job, _)| job.kind == "files" && job.status == "running")
        {
            bail!("Wait for the file operation to finish")
        }
        let string = |key: &str| -> Result<&str> {
            v[key]
                .as_str()
                .with_context(|| format!("Missing field {key}"))
        };
        match action {
            "validate_project_settings" => {
                let workspace = self.working_project(string("path")?)?;
                let project = decode_project(v["project"].clone())?;
                let mut validation = crate::settings::validate(&workspace.path, &project);
                if let Some(id) = v["snapshot_id"].as_str() {
                    let snapshot = self.snapshot(id)?;
                    validation.matches_snapshot = Some(
                        snapshot.project_path.as_ref() == Some(&workspace.path)
                            && snapshot.project_fingerprint.as_ref()
                                == Some(&hash(serde_json::to_vec(&project)?)),
                    );
                }
                Ok(json!(validation))
            }
            "resolve_settings_inputs" => {
                let workspace = self.working_project(string("path")?)?;
                let request: crate::settings::SettingsInputs =
                    serde_json::from_value(v["request"].clone())?;
                Ok(json!(crate::settings::references(
                    &workspace.path,
                    request
                )?))
            }
            "open_project" => {
                let project = workspace::open(Path::new(string("path")?))?;
                self.state
                    .lock()
                    .unwrap()
                    .projects
                    .insert(project.path.to_string_lossy().into_owned(), project.clone());
                Ok(serde_json::to_value(project)?)
            }
            "create_project_draft" => {
                let mut project = workspace::draft(
                    Path::new(string("path")?),
                    string("name")?.into(),
                    serde_json::from_value(v["technology"].clone())?,
                )?;
                let token = format!(
                    "draft-{}",
                    SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
                );
                project.draft_id = Some(token.clone());
                self.state
                    .lock()
                    .unwrap()
                    .projects
                    .insert(token, project.clone());
                Ok(json!(project))
            }
            "publish_project_draft" => {
                let token = string("draft_id")?;
                let project = self.working_project(token)?;
                if project.draft_id.as_deref() != Some(token) {
                    bail!("Not a creation draft")
                }
                let saved = workspace::publish_draft(
                    &project,
                    v["overwrite"].as_bool().unwrap_or(false),
                    v["expected_revision"].as_str(),
                )?;
                let mut state = self.state.lock().unwrap();
                state.projects.remove(token);
                state
                    .projects
                    .insert(saved.path.to_string_lossy().into_owned(), saved.clone());
                Ok(json!(saved))
            }
            "project_overwrite_revision" => {
                let project = self.working_project(string("draft_id")?)?;
                Ok(json!(if project.path.exists() {
                    Some(file_hash(&project.path)?)
                } else {
                    None
                }))
            }
            "close_project" => {
                let key = string("path")?;
                let mut state = self.state.lock().unwrap();
                if state
                    .jobs
                    .values()
                    .any(|(job, _)| job.kind != "lint" && job.status == "running")
                {
                    bail!("Cancel the running job before closing a project")
                }
                for (job, token) in state.jobs.values() {
                    if job.kind == "lint" {
                        token.cancel();
                    }
                }
                state.projects.remove(key);
                state.previews.retain(|_, (path, _, _)| path != key);
                state.file_previews.retain(|_, (path, _, _)| path != key);
                // The desktop owns one visible artifact session. Dropping its parser stops the worker.
                if !key.starts_with("draft-") {
                    state.waves.clear();
                    state.runs.clear();
                    state.snapshots.clear();
                    state.layout_cache = None;
                    state.layout_generation += 1;
                }
                Ok(Value::Null)
            }
            "update_project" => {
                if self
                    .state
                    .lock()
                    .unwrap()
                    .jobs
                    .values()
                    .any(|(job, _)| job.kind != "lint" && job.status == "running")
                {
                    bail!("Wait for the running project job before changing settings")
                }
                let mut project = self.working_project(string("path")?)?;
                project.project = decode_project(v["project"].clone())?;
                validate_project(&project.project)?;
                deduplicate_simulation_files(&project.path, &mut project.project)?;
                self.state
                    .lock()
                    .unwrap()
                    .projects
                    .insert(string("path")?.into(), project.clone());
                Ok(serde_json::to_value(project)?)
            }
            "save_project" => {
                let mut project = self.working_project(string("path")?)?;
                if !v["project"].is_null() {
                    project.project = decode_project(v["project"].clone())?;
                }
                let saved = workspace::save(&project, string("expected_revision")?)?;
                self.state
                    .lock()
                    .unwrap()
                    .projects
                    .insert(saved.path.to_string_lossy().into_owned(), saved.clone());
                Ok(serde_json::to_value(saved)?)
            }
            "preview_import" => {
                let key = string("path")?.to_owned();
                let project = self.working_project(&key)?;
                let request: workspace::ImportRequest =
                    serde_json::from_value(v["request"].clone())?;
                let service = self.clone();
                self.launch("preview_import", move |cancel| {
                    let preview = workspace::preview(&project, &request, &cancel)?;
                    cancel.check()?;
                    let token = format!(
                        "import-{}",
                        SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
                    );
                    service.state.lock().unwrap().previews.insert(
                        token.clone(),
                        (
                            key,
                            hash(serde_json::to_vec(&project.project)?),
                            preview.clone(),
                        ),
                    );
                    Ok(json!({"token":token,"preview":preview}))
                })
            }
            "apply_import" => {
                let token = string("token")?;
                let mut state = self.state.lock().unwrap();
                let (path, revision, preview) = state
                    .previews
                    .get(token)
                    .cloned()
                    .context("Import preview expired")?;
                let project = state
                    .projects
                    .get_mut(&path)
                    .context("Project is no longer open")?;
                if hash(serde_json::to_vec(&project.project)?) != revision {
                    bail!("Project changed; preview the import again")
                }
                project.project = workspace::apply(
                    &preview,
                    &serde_json::from_value::<Vec<workspace::ImportChoice>>(v["choices"].clone())?,
                )?;
                let result = serde_json::to_value(project)?;
                state.previews.remove(token);
                Ok(result)
            }
            "project_files" => Ok(json!(workspace::project_files(
                &self.working_project(string("path")?)?.project
            ))),
            "project_explorer" => Ok(json!(file_management::explorer(
                &self.working_project(string("path")?)?,
                &self.store
            )?)),
            "create_file_entry" | "preview_file_change" | "apply_file_change" => {
                {
                    let state = self.state.lock().unwrap();
                    if state
                        .jobs
                        .values()
                        .any(|(job, _)| job.kind != "lint" && job.status == "running")
                    {
                        bail!("Cancel the running project job before changing files")
                    }
                    for (job, cancel) in state.jobs.values() {
                        if job.kind == "lint" {
                            cancel.cancel();
                        }
                    }
                }
                let key = string("path")?.to_owned();
                let workspace = self.working_project(&key)?;
                if action == "create_file_entry" {
                    let result = file_management::create(
                        &workspace,
                        &serde_json::from_value(v["request"].clone())?,
                        &self.store,
                    )?;
                    self.state
                        .lock()
                        .unwrap()
                        .projects
                        .insert(key, result.workspace.clone());
                    return Ok(json!(result));
                }
                let revision = hash(serde_json::to_vec(&workspace.project)?);
                let service = self.clone();
                if action == "preview_file_change" {
                    let request = serde_json::from_value(v["request"].clone())?;
                    self.launch("files", move |cancel| {
                        let preview =
                            file_management::preview(&workspace, request, &service.store, &cancel)?;
                        cancel.check()?;
                        let token = format!(
                            "file-{}",
                            SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
                        );
                        let mut state = service.state.lock().unwrap();
                        state.file_previews.retain(|_, (path, _, _)| path != &key);
                        state
                            .file_previews
                            .insert(token.clone(), (key, revision, preview.clone()));
                        Ok(json!({"token":token,"preview":preview}))
                    })
                } else {
                    let token = string("token")?.to_owned();
                    let (_, expected, preview) = self
                        .state
                        .lock()
                        .unwrap()
                        .file_previews
                        .get(&token)
                        .filter(|(path, _, _)| path == &key)
                        .cloned()
                        .context("File preview expired; review again")?;
                    if expected != revision {
                        bail!("Project changed; review the operation again")
                    }
                    self.launch("files", move |cancel| {
                        let result =
                            file_management::apply(&workspace, &preview, &service.store, &cancel)?;
                        let mut state = service.state.lock().unwrap();
                        state.projects.insert(key, result.workspace.clone());
                        state.file_previews.remove(&token);
                        Ok(json!(result))
                    })
                }
            }
            "lint" => {
                let request: editor_lint::EditorLintRequest = serde_json::from_value(v)?;
                let project = self.working_project(&request.path)?;
                editor_lint::validate(&project, &request)?;
                let store = self.store.clone();
                self.launch("lint", move |cancel| {
                    Ok(json!(editor_lint::lint(&project, request, &store, cancel)?))
                })
            }
            "read_document" => Ok(serde_json::to_value(workspace::read_document(
                &self.working_project(string("path")?)?,
                &serde_json::from_value(v["file"].clone())?,
            )?)?),
            "save_document" => Ok(serde_json::to_value(workspace::save_document(
                &self.working_project(string("path")?)?,
                &serde_json::from_value(v["document"].clone())?,
            )?)?),
            "working_source" => {
                let snapshot = self.snapshot(string("snapshot_id")?)?;
                let project = self.working_project(string("path")?)?;
                let (file, _, _) = source_location(string("source")?);
                let captured = crate::runner::host_path(&snapshot.directory, file);
                let captured = captured.as_path();
                let relative = if captured.is_absolute() {
                    captured.strip_prefix(snapshot.directory.join("inputs"))?
                } else {
                    captured.strip_prefix("inputs").unwrap_or(captured)
                };
                let original = snapshot
                    .source_origins
                    .get(&portable(relative))
                    .context("No original source mapping for this snapshot")?;
                for reference in workspace::project_files(&project.project) {
                    if resolve_reference(&project.path, &project.project, &reference)
                        .is_ok_and(|p| &p == original)
                    {
                        return Ok(json!(reference));
                    }
                }
                bail!("Original source is not registered in the current working project")
            }
            "toolchain_status" => {
                let p: ToolchainProfile = serde_json::from_value(v["profile"].clone())?;
                Ok(json!(crate::runner::toolchain_status(&p)))
            }
            "probe" => {
                let p: ToolchainProfile = serde_json::from_value(v["profile"].clone())?;
                let dir = unique_dir(&self.store, "probe")?;
                self.launch("probe", move |c| Ok(Runner::new(p, dir, c).check()))
            }
            "build" => {
                let path = PathBuf::from(string("path")?);
                let p: ToolchainProfile = serde_json::from_value(v["profile"].clone())?;
                let rep: Representation = serde_json::from_value(v["representation"].clone())?;
                let service = self.clone();
                self.launch("build", move |c| {
                    let snapshot = Arc::new(pipeline::compile(&path, p, rep, &service.store, c)?);
                    service.remember_snapshot(snapshot.clone());
                    Ok(serde_json::to_value(&*snapshot)?)
                })
            }
            "open_snapshot" => {
                let snapshot = Arc::new(read_snapshot(Path::new(string("path")?))?);
                self.remember_snapshot(snapshot.clone());
                Ok(serde_json::to_value(&*snapshot)?)
            }
            "simulate" => {
                let snapshot = self.snapshot(string("snapshot_id")?)?;
                if let Some(path) = v["project_path"].as_str() {
                    let project = self.working_project(path)?;
                    if snapshot.project_path.as_ref() != Some(&project.path)
                        || snapshot.project_fingerprint.as_ref()
                            != Some(&hash(serde_json::to_vec(&project.project)?))
                    {
                        bail!("Rebuild the schematic to use updated project settings")
                    }
                }
                read_snapshot(&snapshot.directory.join("snapshot.json"))?;
                let name = string("name")?.to_owned();
                let service = self.clone();
                self.launch("simulate", move |c| {
                    let run = simulation::simulate(&snapshot, &name, c.clone())?;
                    service.register_run(run, c)
                })
            }
            "import_trace" => {
                let snapshot = self.snapshot(string("snapshot_id")?)?;
                let path = PathBuf::from(string("path")?);
                let scope = serde_json::from_value(v["dut_scope"].clone())?;
                let service = self.clone();
                self.launch("import", move |c| {
                    c.check()?;
                    let run = waveform::prepare_import(&snapshot, &path, scope, &service.store)?;
                    c.check()?;
                    service.register_run(run, c)
                })
            }
            "open_run" => {
                let path = PathBuf::from(string("path")?);
                let snapshot = self.snapshot(string("snapshot_id")?)?;
                let service = self.clone();
                self.launch("open_run", move |c| {
                    c.check()?;
                    let run = crate::lifecycle::validate_run(&path, &snapshot)?;
                    service.register_run(run, c)
                })
            }
            "view" => {
                let snapshot = self.snapshot(string("snapshot_id")?)?;
                let scope: Vec<String> = serde_json::from_value(v["scope"].clone())?;
                let options: SchematicOptions =
                    serde_json::from_value(v.get("options").cloned().unwrap_or_else(|| json!({})))?;
                Ok(serde_json::to_value(crate::schematic::view(
                    &snapshot,
                    &scope,
                    v["focus"].as_str(),
                    v["limit"]
                        .as_u64()
                        .map_or(crate::graph::LOGIC_LIMIT, |n| n as usize),
                    v["split_buses"].as_bool().unwrap_or(false),
                    &options,
                )?)?)
            }
            "bindings" | "map_signal" => {
                let (run, snapshot, info) = {
                    let s = self.state.lock().unwrap();
                    let run = s
                        .runs
                        .get(string("run_id")?)
                        .context("Open a simulation run")?;
                    let snapshot = s
                        .snapshots
                        .get(&run.snapshot_id)
                        .context("Open a snapshot")?;
                    let wave = s.waves.get(&run.id).context("Reopen this waveform")?;
                    (run.clone(), snapshot.clone(), wave.info.clone())
                };
                let path = run.directory.join("bindings.json");
                let mut manual: BTreeMap<String, u32> = if path.exists() {
                    read_json(&path)?
                } else {
                    BTreeMap::new()
                };
                if action == "map_signal" {
                    manual.insert(
                        string("signal_id")?.into(),
                        v["variable_id"].as_u64().context("variable_id required")? as u32,
                    );
                }
                let bindings = waveform::bindings(&snapshot, &run, &info, &manual)?;
                if action == "map_signal" {
                    atomic_json(&path, &manual)?;
                }
                Ok(json!(bindings))
            }
            "close_run" => {
                self.state.lock().unwrap().waves.remove(string("run_id")?);
                Ok(Value::Null)
            }
            "wave_info" => {
                let s = self.state.lock().unwrap();
                Ok(json!(
                    *s.waves
                        .get(string("run_id")?)
                        .context("Open a waveform")?
                        .info
                ))
            }
            "wave_edge" => {
                let wave = self
                    .state
                    .lock()
                    .unwrap()
                    .waves
                    .get(string("run_id")?)
                    .context("Open a waveform")?
                    .process
                    .clone();
                let mut wave = wave.lock().unwrap_or_else(|e| e.into_inner());
                let edge = wave.edge(
                    v["id"].as_u64().context("id required")? as u32,
                    string("time")?.parse()?,
                    string("direction")? == "next",
                    v["bit"].as_u64().map(|bit| bit as usize),
                )?;
                Ok(json!(edge.map(|time| time.to_string())))
            }
            "wave_window" | "wave_values" => {
                let wave = self
                    .state
                    .lock()
                    .unwrap()
                    .waves
                    .get(string("run_id")?)
                    .context("Open a waveform")?
                    .process
                    .clone();
                let ids: Vec<u32> = serde_json::from_value(v["ids"].clone())?;
                let start = string("start")?.parse::<u64>()?;
                let end = if action == "wave_values" {
                    start
                } else {
                    string("end")?.parse()?
                };
                let mut wave = wave.lock().unwrap_or_else(|e| e.into_inner());
                Ok(json!(wave.window(
                    &ids,
                    start,
                    end,
                    v["pixels"].as_u64().unwrap_or(1200) as usize
                )?))
            }
            "jobs" => Ok(json!(self
                .state
                .lock()
                .unwrap()
                .jobs
                .values()
                .map(|(j, _)| j.clone())
                .collect::<Vec<_>>())),
            "job" => Ok(json!(
                self.state
                    .lock()
                    .unwrap()
                    .jobs
                    .get(string("id")?)
                    .context("Unknown job")?
                    .0
            )),
            "cancel" => {
                self.state
                    .lock()
                    .unwrap()
                    .jobs
                    .get(string("id")?)
                    .context("Unknown job")?
                    .1
                    .cancel();
                Ok(Value::Null)
            }
            "logs" => {
                let mut files = Vec::new();
                collect_logs(&self.store, &mut files)?;
                files.sort_by_key(|p| fs::metadata(p).and_then(|m| m.modified()).ok());
                let text = files
                    .iter()
                    .rev()
                    .take(4)
                    .rev()
                    .map(|p| format!("{}\n{}", p.display(), tail(p, 16000).unwrap_or_default()))
                    .collect::<Vec<_>>()
                    .join("\n");
                Ok(json!(text))
            }
            "report" => {
                let snapshot = self.snapshot(string("snapshot_id")?)?;
                let path = PathBuf::from(string("path")?);
                let physical = snapshot.physical_run.as_ref().context("No physical run")?;
                if !physical.reports.contains(&path) {
                    bail!("Not a report from this physical run")
                }
                Ok(json!(tail(&path, 2_000_000)?))
            }
            // The block outline, cells and pins; each layer's wires are asked for
            // when the layer is shown.
            "layout" | "layout_shapes" => {
                let snapshot = self.snapshot(string("snapshot_id")?)?;
                let layout = self.physical_layout(&snapshot)?;
                if action == "layout_shapes" {
                    let layer = v["layer"].as_u64().context("Missing layer")? as usize;
                    let shapes =
                        |key: &str| layout[key].get(layer).cloned().unwrap_or_else(|| json!([]));
                    Ok(json!({"wires": shapes("wires"), "power": shapes("power")}))
                } else {
                    let mut outline = layout
                        .as_object()
                        .context("Invalid layout object")?
                        .iter()
                        .filter(|(key, _)| *key != "wires" && *key != "power")
                        .map(|(key, value)| (key.clone(), value.clone()))
                        .collect::<serde_json::Map<String, Value>>();
                    for key in ["wires", "power"] {
                        let counts: Vec<usize> = layout[key]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .map(|shapes| shapes.as_array().map_or(0, Vec::len))
                            .collect();
                        outline.insert(key.into(), json!(counts));
                    }
                    Ok(Value::Object(outline))
                }
            }

            "checks" => {
                let snapshot = self.snapshot(string("snapshot_id")?)?;
                let path = snapshot
                    .physical_run
                    .as_ref()
                    .and_then(|run| run.checks.as_ref())
                    .context("This snapshot has no check results")?;
                read_json::<Value>(path)
            }
            // The final GDS with the PDK layer file's names, colours and patterns.
            "layout_masks" => {
                let snapshot = self.snapshot(string("snapshot_id")?)?;
                let run = snapshot.physical_run.as_ref();
                let (gds, layers) = run
                    .and_then(|run| Some((run.gds.as_ref()?, run.layer_file.as_ref()?)))
                    .context("This snapshot has no mask view")?;
                Ok(serde_json::to_value(masks::view(gds, layers)?)?)
            }
            // The final GDS extruded with the PDK's 2.5D stack, whole or within a box
            // of database units.
            "layout_solid" => {
                let snapshot = self.snapshot(string("snapshot_id")?)?;
                let run = snapshot.physical_run.as_ref();
                let (gds, layers, stack) = run
                    .and_then(|run| {
                        Some((
                            run.gds.as_ref()?,
                            run.layer_file.as_ref()?,
                            run.stack_file.as_ref()?,
                        ))
                    })
                    .context("This snapshot has no 3D view")?;
                let region = match &v["box"] {
                    Value::Null => None,
                    value => {
                        let region: [i32; 4] = serde_json::from_value(value.clone())
                            .context("box must be four database-unit coordinates")?;
                        if region[0] > region[2] || region[1] > region[3] {
                            bail!("box must be x0, y0, x1, y1 with x0 <= x1 and y0 <= y1");
                        }
                        Some(region)
                    }
                };
                Ok(serde_json::to_value(solid::view(
                    gds, layers, stack, region,
                )?)?)
            }
            "source" => {
                let snapshot = self.snapshot(string("snapshot_id")?)?;
                let raw = string("source")?;
                let (file, line, col) = source_location(raw);
                let path = crate::runner::host_path(&snapshot.directory, file);
                let path = if path.is_absolute() {
                    path
                } else {
                    let path = path.strip_prefix("inputs").unwrap_or(&path);
                    snapshot.directory.join("inputs").join(path)
                };
                let canonical = path.canonical()?;
                if !canonical.starts_with(snapshot.directory.join("inputs")) {
                    bail!("Source reference is outside captured inputs")
                }
                Ok(
                    json!({"text":fs::read_to_string(canonical)?,"line":line,"column":col,"file":file}),
                )
            }
            "save_project_state" => {
                let project = self.working_project(string("path")?)?;
                crate::lifecycle::save(
                    &self.store,
                    &project,
                    Path::new(string("snapshot_path")?),
                    v["run_path"].as_str().map(Path::new),
                )?;
                Ok(Value::Null)
            }
            "restore_project_state" => {
                let project = self.working_project(string("path")?)?;
                let restored = crate::lifecycle::restore(&self.store, &project);
                if let Some(snapshot) = &restored.snapshot {
                    self.remember_snapshot(Arc::new(snapshot.clone()));
                }
                Ok(json!(restored))
            }
            _ => bail!("Unknown action {action}"),
        }
    }
}
fn collect_logs(dir: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    if !dir.exists() {
        return Ok(());
    }
    for e in fs::read_dir(dir)? {
        let p = e?.path();
        if p.is_dir() {
            collect_logs(&p, out)?
        } else if p.extension().is_some_and(|s| s == "log") {
            out.push(p)
        }
    }
    Ok(())
}
fn tail(path: &Path, max: u64) -> Result<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = fs::File::open(path)?;
    let len = f.metadata()?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(max)))?;
    let mut b = Vec::new();
    f.read_to_end(&mut b)?;
    Ok(String::from_utf8_lossy(&b).into_owned())
}

#[cfg(test)]
mod lint_tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn wait(service: &Service, id: &str) -> Value {
        let started = Instant::now();
        loop {
            let job = service.request("job", json!({ "id": id })).unwrap();
            if job["status"] != "running" {
                return job;
            }
            assert!(started.elapsed() < Duration::from_secs(3));
            thread::sleep(Duration::from_millis(5));
        }
    }
    #[test]
    fn a_layout_is_served_without_its_wires_and_each_layer_on_request() {
        let temp = tempfile::tempdir().unwrap();
        let layout = temp.path().join("layout.json");
        fs::write(
            &layout,
            r#"{"dbu":1000,"die":[0,0,9,9],"layers":["met1","met2"],"instances":[["u1",0,1,1,2,2]],
                "wires":[[[0,0,1,1,0],[1,1,2,2,0]],[]],"power":[[],[[0,0,9,1,1]]]}"#,
        )
        .unwrap();
        let service = Service::new(temp.path().join("store"));
        let snapshot = |id: &str, run: Value| -> DesignSnapshot {
            serde_json::from_value(json!({"schema_version":SCHEMA,"id":id,"representation":"post_layout","project_path":null,"project_fingerprint":null,
                "project":{"schema_version":PROJECT_SCHEMA,"name":"p","top":"top","sources":[]},"profile":ToolchainProfile::default(),
                "directory":temp.path(),"design":{"modules":{},"scopes":[]},"diagnostics":[],"tool_versions":{},"input_hashes":{},
                "artifact_hashes":{},"source_origins":{},"netlist":null,"sdf":{},"physical_run":run})).unwrap()
        };
        let gds = temp.path().join("final.gds");
        fs::write(
            &gds,
            crate::gds::tests::library(&[crate::gds::tests::cell(
                "top",
                &[crate::gds::tests::boundary(
                    68,
                    20,
                    &[0, 0, 0, 5, 10, 5, 10, 0],
                )],
            )]),
        )
        .unwrap();
        let layers = temp.path().join("layers.lyp");
        fs::write(&layers, "<layer-properties><properties><fill-color>#0000ff</fill-color><frame-color>#0000ff</frame-color><dither-pattern>I0</dither-pattern><name>met1</name><source>68/20@1</source></properties></layer-properties>").unwrap();
        let stack = temp.path().join("stack.lyd25");
        fs::write(&stack, "<klayout-macro><text>z(input(68, 20), zstart: 1.2, height: 0.3)</text></klayout-macro>").unwrap();
        let run = |layout: Value, masks: bool| json!({"status":"complete","flow_error":null,"directory":temp.path(),"state":{},"reports":[],"layout":layout,"gds":masks.then(|| gds.clone()),"layer_file":masks.then(|| layers.clone()),"stack_file":masks.then(|| stack.clone()),"checks":null});
        for (id, run) in [
            ("routed", run(json!(layout), true)),
            ("bare", run(Value::Null, false)),
        ] {
            let mut state = service.state.lock().unwrap();
            state
                .snapshots
                .insert(id.into(), Arc::new(snapshot(id, run)));
        }
        let outline = service
            .request("layout", json!({"snapshot_id":"routed"}))
            .unwrap();
        assert_eq!(outline["instances"], json!([["u1", 0, 1, 1, 2, 2]]));
        assert_eq!(outline["wires"], json!([2, 0]));
        assert_eq!(outline["power"], json!([0, 1]));
        let layer = |layer: u64| {
            service
                .request(
                    "layout_shapes",
                    json!({"snapshot_id":"routed","layer":layer}),
                )
                .unwrap()
        };
        assert_eq!(
            layer(0),
            json!({"wires":[[0,0,1,1,0],[1,1,2,2,0]],"power":[]})
        );
        assert_eq!(layer(1), json!({"wires":[],"power":[[0,0,9,1,1]]}));
        assert_eq!(layer(7), json!({"wires":[],"power":[]}));
        // Layer requests share the captured JSON; none reread or take from it.
        fs::remove_file(&layout).unwrap();
        assert_eq!(layer(0)["wires"].as_array().unwrap().len(), 2);
        assert_eq!(layer(1)["power"], json!([[0, 0, 9, 1, 1]]));
        fs::write(&layout, r#"{"wires":[[[2,2,3,3,0]]],"power":[[]]}"#).unwrap();
        service.remember_snapshot(service.snapshot("routed").unwrap());
        assert_eq!(layer(0)["wires"], json!([[2, 2, 3, 3, 0]]));
        let masks = service
            .request("layout_masks", json!({"snapshot_id":"routed"}))
            .unwrap();
        assert_eq!(masks["layers"][0]["name"], "met1");
        assert_eq!(masks["layers"][0]["pattern"], json!(["*"]));
        assert_eq!(masks["shapes"][0]["boxes"], json!([0, 0, 10, 5]));
        let solid = service
            .request("layout_solid", json!({"snapshot_id":"routed"}))
            .unwrap();
        assert_eq!(
            solid["materials"],
            json!([{"name":"met1","fill":"#0000ff","source":"68/20"}])
        );
        assert_eq!(
            solid["slabs"],
            json!([{"material":0,"zstart":1.2,"zstop":1.5}])
        );
        assert_eq!(solid["shapes"][0]["boxes"], json!([0, 0, 10, 5]));
        let outside = service
            .request(
                "layout_solid",
                json!({"snapshot_id":"routed","box":[20,20,30,30]}),
            )
            .unwrap();
        assert_eq!(outside["materials"], json!([]));
        let error = service
            .request(
                "layout_solid",
                json!({"snapshot_id":"routed","box":[5,0,0,0]}),
            )
            .unwrap_err();
        assert!(error.to_string().contains("x0 <= x1"));
        for action in ["layout", "checks", "layout_masks", "layout_solid"] {
            let error = service
                .request(action, json!({"snapshot_id":"bare"}))
                .unwrap_err();
            assert!(error.to_string().starts_with("This snapshot has no"));
        }
        service
            .request("close_project", json!({"path":"closed"}))
            .unwrap();
        assert!(service.state.lock().unwrap().layout_cache.is_none());
    }
    #[test]
    fn settings_validation_is_read_only_and_stale_configurations_cannot_launch_simulation() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = workspace::create(
            &temp.path().join("hdlview.project.json"),
            "empty".into(),
            false,
        )
        .unwrap();
        let path = workspace.path.to_string_lossy().into_owned();
        let original = fs::read(&workspace.path).unwrap();
        let service = Service::new(temp.path().join("store"));
        service
            .request("open_project", json!({"path":path}))
            .unwrap();
        let snapshot: DesignSnapshot = serde_json::from_value(json!({"schema_version":2,"id":"captured","representation":"elaborated","project_path":workspace.path,"project_fingerprint":hash(serde_json::to_vec(&workspace.project).unwrap()),"project":workspace.project,"profile":ToolchainProfile::default(),"directory":temp.path().join("artifact"),"design":{"modules":{},"scopes":[]},"diagnostics":[],"tool_versions":{},"input_hashes":{},"artifact_hashes":{},"source_origins":{},"netlist":null,"sdf":{}})).unwrap();
        service
            .state
            .lock()
            .unwrap()
            .snapshots
            .insert(snapshot.id.clone(), Arc::new(snapshot));
        let mut candidate = workspace.project.clone();
        candidate.name = "changed".into();
        let result = service
            .request(
                "validate_project_settings",
                json!({"path":path,"project":candidate,"snapshot_id":"captured"}),
            )
            .unwrap();
        assert_eq!(result["matches_snapshot"], false);
        assert_eq!(
            service.working_project(&path).unwrap().project.name,
            "empty"
        );
        assert_eq!(fs::read(&workspace.path).unwrap(), original);
        service
            .request("update_project", json!({"path":path,"project":candidate}))
            .unwrap();
        let error = service
            .request(
                "simulate",
                json!({"snapshot_id":"captured","name":"default","project_path":path}),
            )
            .unwrap_err();
        assert!(error.to_string().contains("Rebuild"));
        assert!(service.state.lock().unwrap().jobs.is_empty());
        assert!(!temp.path().join("artifact").exists());
        assert_eq!(fs::read(&workspace.path).unwrap(), original);
    }
    #[test]
    fn background_lint_does_not_block_close_and_retention_is_bounded() {
        let directory = tempfile::tempdir().unwrap();
        let service = Service::new(directory.path().into());
        let (started, received) = std::sync::mpsc::channel();
        let job = service
            .launch("lint", move |cancel| {
                started.send(()).unwrap();
                loop {
                    cancel.check()?;
                    thread::sleep(Duration::from_millis(5));
                }
            })
            .unwrap();
        received.recv_timeout(Duration::from_secs(1)).unwrap();
        service
            .request("close_project", json!({"path":"project"}))
            .unwrap();
        assert_eq!(
            wait(&service, job["id"].as_str().unwrap())["status"],
            "cancelled"
        );
        for _ in 0..5 {
            let job = service.launch("lint", |_| Ok(Value::Null)).unwrap();
            assert_eq!(
                wait(&service, job["id"].as_str().unwrap())["status"],
                "complete"
            );
        }
        let jobs = service.request("jobs", json!({})).unwrap();
        assert_eq!(jobs.as_array().unwrap().len(), 1);
    }
    #[test]
    fn user_jobs_cancel_lint_but_keep_project_transition_guard() {
        let directory = tempfile::tempdir().unwrap();
        let service = Service::new(directory.path().into());
        let lint = service
            .launch("lint", |cancel| loop {
                cancel.check()?;
                thread::sleep(Duration::from_millis(5));
            })
            .unwrap();
        let (release, held) = std::sync::mpsc::channel();
        let job = service
            .launch("build", move |_| {
                held.recv_timeout(Duration::from_secs(3))?;
                Ok(Value::Null)
            })
            .unwrap();
        assert_eq!(
            wait(&service, lint["id"].as_str().unwrap())["status"],
            "cancelled"
        );
        assert!(service.launch("lint", |_| Ok(Value::Null)).is_err());
        assert!(service
            .request("close_project", json!({"path":"project"}))
            .is_err());
        release.send(()).unwrap();
        assert_eq!(
            wait(&service, job["id"].as_str().unwrap())["status"],
            "complete"
        );
        service
            .request("close_project", json!({"path":"project"}))
            .unwrap();
    }
    #[test]
    fn file_previews_reject_stale_projects_and_jobs_are_bounded() {
        let directory = tempfile::tempdir().unwrap();
        let store = tempfile::tempdir().unwrap();
        let service = Service::new(store.path().into());
        let workspace = workspace::create(
            &directory.path().join("hdlview.project.json"),
            "files".into(),
            false,
        )
        .unwrap();
        let path = workspace.path.clone();
        service
            .request("open_project", json!({"path":path}))
            .unwrap();
        service.request("create_file_entry",json!({"path":path,"request":{"directory":directory.path().join("rtl"),"name":"a.sv","group":"design","folder":false}})).unwrap();
        let mut token = Value::Null;
        for _ in 0..4 {
            let job = service.request("preview_file_change", json!({"path":path,"request":{"file":"rtl/a.sv","directory":false,"kind":"remove"}})).unwrap();
            let complete = wait(&service, job["id"].as_str().unwrap());
            assert_eq!(complete["status"], "complete");
            token = complete["result"]["token"].clone();
        }
        assert_eq!(
            service
                .request("jobs", json!({}))
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let mut workspace = service.working_project(path.to_str().unwrap()).unwrap();
        workspace.project.name = "changed".into();
        service
            .request(
                "update_project",
                json!({"path":path,"project":workspace.project}),
            )
            .unwrap();
        assert!(service
            .request("apply_file_change", json!({"path":path,"token":token}))
            .is_err());
        assert!(directory.path().join("rtl/a.sv").exists());
        let (release, held) = std::sync::mpsc::channel();
        let job = service
            .launch("files", move |_| {
                held.recv_timeout(Duration::from_secs(3))?;
                Ok(Value::Null)
            })
            .unwrap();
        assert!(service
            .request("close_project", json!({"path":path}))
            .is_err());
        assert!(service
            .request("save_document", json!({"path":path}))
            .is_err());
        release.send(()).unwrap();
        assert_eq!(
            wait(&service, job["id"].as_str().unwrap())["status"],
            "complete"
        );
    }
}
