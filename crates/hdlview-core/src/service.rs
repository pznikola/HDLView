use crate::{
    graph, model::*, pipeline, project::*, runner::*, simulation, waveform,
    waveprocess::WaveProcess,
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
    snapshots: BTreeMap<String, DesignSnapshot>,
    runs: BTreeMap<String, SimulationRun>,
    waves: BTreeMap<String, WaveProcess>,
    jobs: BTreeMap<String, (Job, CancelToken)>,
}
#[derive(Clone)]
pub struct Service {
    state: Arc<Mutex<State>>,
    pub store: PathBuf,
}
impl Service {
    pub fn new(store: PathBuf) -> Self {
        Self {
            store,
            state: Arc::new(Mutex::new(State {
                snapshots: BTreeMap::new(),
                runs: BTreeMap::new(),
                waves: BTreeMap::new(),
                jobs: BTreeMap::new(),
            })),
        }
    }
    fn snapshot(&self, id: &str) -> Result<DesignSnapshot> {
        self.state
            .lock()
            .unwrap()
            .snapshots
            .get(id)
            .cloned()
            .context("Open a snapshot first")
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
        self.state
            .lock()
            .unwrap()
            .jobs
            .insert(id.clone(), (job.clone(), token.clone()));
        let state = self.state.clone();
        thread::spawn(move || {
            let result =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(token.clone())));
            let mut s = state.lock().unwrap();
            let j = &mut s.jobs.get_mut(&id).unwrap().0;
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
        s.waves.insert(run.id.clone(), wave);
        s.runs.insert(run.id.clone(), run.clone());
        Ok(serde_json::to_value(run)?)
    }
    pub fn request(&self, action: &str, v: Value) -> Result<Value> {
        let string = |key: &str| -> Result<&str> {
            v[key]
                .as_str()
                .with_context(|| format!("Missing field {key}"))
        };
        match action {
            "open_project" => {
                let path = PathBuf::from(string("path")?);
                Ok(json!({"path":path.canonicalize()?,"project":load_project(&path)?}))
            }
            "save_project" => {
                let path = PathBuf::from(string("path")?).canonicalize()?;
                let project: ProjectConfig = serde_json::from_value(v["project"].clone())?;
                validate_project(&project)?;
                atomic_json(&path, &project)?;
                Ok(json!(project))
            }
            "load_profile" => {
                let p: ToolchainProfile = read_json(Path::new(string("path")?))?;
                Ok(serde_json::to_value(p)?)
            }
            "probe" => {
                let p: ToolchainProfile = serde_json::from_value(v["profile"].clone())?;
                let dir = unique_dir(&self.store, "probe")?;
                self.launch("probe", move |c| Ok(json!(Runner::new(p, dir, c).probe())))
            }
            "build" => {
                let path = PathBuf::from(string("path")?);
                let p: ToolchainProfile = serde_json::from_value(v["profile"].clone())?;
                let rep: Representation = serde_json::from_value(v["representation"].clone())?;
                let service = self.clone();
                self.launch("build", move |c| {
                    let snapshot = pipeline::compile(&path, p, rep, &service.store, c)?;
                    service
                        .state
                        .lock()
                        .unwrap()
                        .snapshots
                        .insert(snapshot.id.clone(), snapshot.clone());
                    Ok(serde_json::to_value(snapshot)?)
                })
            }
            "open_snapshot" => {
                let snapshot = read_snapshot(Path::new(string("path")?))?;
                self.state
                    .lock()
                    .unwrap()
                    .snapshots
                    .insert(snapshot.id.clone(), snapshot.clone());
                Ok(serde_json::to_value(snapshot)?)
            }
            "simulate" => {
                let snapshot = self.snapshot(string("snapshot_id")?)?;
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
                    let run: SimulationRun = read_json(&path)?;
                    if run.schema_version != SCHEMA
                        || run.snapshot_id != snapshot.id
                        || run.representation != snapshot.representation
                    {
                        bail!("Run is bound to another schematic snapshot")
                    }
                    if file_hash(&run.trace)? != run.trace_hash {
                        bail!("Waveform artifact changed")
                    }
                    service.register_run(run, c)
                })
            }
            "view" => {
                let snapshot = self.snapshot(string("snapshot_id")?)?;
                let scope: Vec<String> = serde_json::from_value(v["scope"].clone())?;
                Ok(serde_json::to_value(graph::view_with_options(
                    &snapshot,
                    &scope,
                    v["focus"].as_str(),
                    v["limit"].as_u64().unwrap_or(2000) as usize,
                    v["split_buses"].as_bool().unwrap_or(false),
                )?)?)
            }
            "bindings" => {
                let s = self.state.lock().unwrap();
                let run = s
                    .runs
                    .get(string("run_id")?)
                    .context("Open a simulation run")?;
                let snapshot = s
                    .snapshots
                    .get(string("snapshot_id")?)
                    .context("Open a snapshot")?;
                let wave = s.waves.get(&run.id).context("Reopen this waveform")?;
                let manualpath = run.directory.join("bindings.json");
                let manual: BTreeMap<String, u32> = if manualpath.exists() {
                    read_json(&manualpath)?
                } else {
                    BTreeMap::new()
                };
                Ok(serde_json::to_value(waveform::bindings(
                    snapshot, run, &wave.info, &manual,
                )?)?)
            }
            "map_signal" => {
                let s = self.state.lock().unwrap();
                let run = s
                    .runs
                    .get(string("run_id")?)
                    .context("Open a simulation run")?;
                let snapshot = s.snapshots.get(&run.snapshot_id).unwrap();
                let wave = s.waves.get(&run.id).context("Reopen waveform")?;
                let path = run.directory.join("bindings.json");
                let mut manual: BTreeMap<String, u32> = if path.exists() {
                    read_json(&path)?
                } else {
                    BTreeMap::new()
                };
                manual.insert(
                    string("signal_id")?.into(),
                    v["variable_id"].as_u64().context("variable_id required")? as u32,
                );
                let bindings = waveform::bindings(snapshot, run, &wave.info, &manual)?;
                atomic_json(&path, &manual)?;
                Ok(json!(bindings))
            }
            "close_run" => {
                self.state.lock().unwrap().waves.remove(string("run_id")?);
                Ok(Value::Null)
            }
            "wave_info" => {
                let s = self.state.lock().unwrap();
                Ok(json!(
                    s.waves
                        .get(string("run_id")?)
                        .context("Open a waveform")?
                        .info
                ))
            }
            "wave_window" | "wave_values" => {
                let mut s = self.state.lock().unwrap();
                let wave = s
                    .waves
                    .get_mut(string("run_id")?)
                    .context("Open a waveform")?;
                let ids: Vec<u32> = serde_json::from_value(v["ids"].clone())?;
                let start = string("start")?.parse::<u64>()?;
                let end = if action == "wave_values" {
                    start
                } else {
                    string("end")?.parse()?
                };
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
                let physical = snapshot.physical_run.context("No physical run")?;
                if !physical.reports.contains(&path) {
                    bail!("Not a report from this physical run")
                }
                Ok(json!(tail(&path, 2_000_000)?))
            }
            "source" => {
                let snapshot = self.snapshot(string("snapshot_id")?)?;
                let raw = string("source")?;
                let (file, line, col) = source_location(raw);
                let path = PathBuf::from(file);
                let path = if path.is_absolute() {
                    path
                } else {
                    snapshot.directory.join("inputs").join(path)
                };
                let canonical = path.canonicalize()?;
                if !canonical.starts_with(snapshot.directory.join("inputs")) {
                    bail!("Source reference is outside captured inputs")
                }
                Ok(
                    json!({"text":fs::read_to_string(canonical)?,"line":line,"column":col,"file":file}),
                )
            }
            "save_session" => {
                let id = string("snapshot_id")?;
                self.snapshot(id)?;
                let path = self.store.join("last-session.json");
                atomic_json(&path, &v)?;
                Ok(json!(path))
            }
            "restore_session" => {
                let path = self.store.join("last-session.json");
                if path.exists() {
                    read_json(&path)
                } else {
                    Ok(Value::Null)
                }
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
