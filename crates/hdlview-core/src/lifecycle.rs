//! Machine-local project artifact checkpoints; working documents remain explicit saves.
use crate::{model::*, project::*, workspace::WorkspaceProject};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize)]
pub struct ProjectState {
    pub schema_version: u32,
    pub project_path: PathBuf,
    pub snapshot_path: PathBuf,
    pub run_path: Option<PathBuf>,
}
#[derive(Serialize)]
pub struct RestoredProject {
    pub snapshot: Option<DesignSnapshot>,
    pub run_path: Option<PathBuf>,
    pub stale: bool,
    pub warnings: Vec<String>,
}
fn state_path(store: &Path, project: &Path) -> PathBuf {
    store.join("project-state").join(format!(
        "{}.json",
        hash(project.as_os_str().as_encoded_bytes())
    ))
}
pub fn validate_run(path: &Path, snapshot: &DesignSnapshot) -> Result<SimulationRun> {
    let run: SimulationRun = read_json(path)?;
    if run.schema_version != SCHEMA
        || run.snapshot_id != snapshot.id
        || run.representation != snapshot.representation
    {
        bail!("Run is bound to another schematic snapshot")
    }
    let actual = path
        .canonical()?
        .parent()
        .context("Run has no directory")?
        .to_path_buf();
    if run.directory != actual {
        bail!("Simulation run was moved")
    }
    if file_hash(&run.trace)? != run.trace_hash {
        bail!("Waveform artifact changed")
    }
    Ok(run)
}
pub fn save(
    store: &Path,
    workspace: &WorkspaceProject,
    snapshot_path: &Path,
    run_path: Option<&Path>,
) -> Result<()> {
    let snapshot = read_snapshot(snapshot_path)?;
    if snapshot.project_path.as_ref() != Some(&workspace.path) {
        bail!("Snapshot belongs to a different project")
    }
    if let Some(path) = run_path {
        validate_run(path, &snapshot)?;
    }
    atomic_json(
        &state_path(store, &workspace.path),
        &ProjectState {
            schema_version: 1,
            project_path: workspace.path.clone(),
            snapshot_path: snapshot_path.canonical()?,
            run_path: run_path.map(Path::canonical).transpose()?,
        },
    )
}
pub fn restore(store: &Path, workspace: &WorkspaceProject) -> RestoredProject {
    let mut result = RestoredProject {
        snapshot: None,
        run_path: None,
        stale: false,
        warnings: Vec::new(),
    };
    let path = state_path(store, &workspace.path);
    if !path.exists() {
        return result;
    }
    let load = || -> Result<ProjectState> {
        let state: ProjectState = read_json(&path)?;
        if state.schema_version != 1 || state.project_path != workspace.path {
            bail!("Invalid project artifact checkpoint")
        }
        Ok(state)
    };
    let state = match load() {
        Ok(s) => s,
        Err(e) => {
            result
                .warnings
                .push(format!("Cannot restore project artifacts: {e:#}"));
            return result;
        }
    };
    let snapshot = match read_snapshot(&state.snapshot_path) {
        Ok(s) if s.project_path.as_ref() == Some(&workspace.path) => s,
        Ok(_) => {
            result
                .warnings
                .push("Saved schematic belongs to another project".into());
            return result;
        }
        Err(e) => {
            result
                .warnings
                .push(format!("Cannot restore schematic: {e:#}"));
            return result;
        }
    };
    let config = workspace.project.clone();
    let fingerprint = match serde_json::to_vec(&config) {
        Ok(bytes) => Some(hash(bytes)),
        Err(e) => {
            result
                .warnings
                .push(format!("Cannot compare working configuration: {e}"));
            None
        }
    };
    result.stale = fingerprint.is_none()
        || snapshot.project_fingerprint != fingerprint
        || snapshot.source_origins.iter().any(|(name, original)| {
            file_hash(original).ok().as_ref() != snapshot.input_hashes.get(name)
        });
    if let Some(path) = state.run_path {
        match validate_run(&path, &snapshot) {
            Ok(_) => result.run_path = Some(path),
            Err(e) => result
                .warnings
                .push(format!("Cannot restore waveform: {e:#}")),
        }
    }
    result.snapshot = Some(snapshot);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    fn fixture(base: &Path, name: &str) -> (WorkspaceProject, PathBuf, PathBuf) {
        let root = base.join(name);
        fs::create_dir(&root).unwrap();
        let root = root.canonical().unwrap();
        fs::write(root.join("top.v"), "module top; endmodule\n").unwrap();
        let mut workspace =
            crate::workspace::create(&root.join("hdlview.project.json"), name.into(), false)
                .unwrap();
        workspace.project.sources.push(SourceFile {
            path: "top.v".into(),
            language: Language::Verilog,
        });
        workspace.project.top = "top".into();
        workspace = crate::workspace::save(&workspace, &workspace.revision).unwrap();
        let artifact = root.join("artifact");
        fs::create_dir(&artifact).unwrap();
        let captured = capture(&workspace.path, &workspace.project, &artifact).unwrap();
        let snapshot: DesignSnapshot = serde_json::from_value(serde_json::json!({
            "schema_version": SCHEMA, "id": name, "representation": "elaborated", "project": captured.project,
            "project_path": workspace.path, "project_fingerprint": hash(serde_json::to_vec(&workspace.project).unwrap()),
            "profile": ToolchainProfile::default(), "directory": artifact, "design": {"modules":{},"scopes":[]},
            "diagnostics": [], "tool_versions": {}, "input_hashes":captured.hashes, "artifact_hashes":{},
            "source_origins":captured.origins, "netlist":null, "sdf":{}
        })).unwrap();
        atomic_json(
            &artifact.join("project-origin.json"),
            &(&snapshot.project_path, &snapshot.project_fingerprint),
        )
        .unwrap();
        let snapshot_path = artifact.join("snapshot.json");
        atomic_json(&snapshot_path, &snapshot).unwrap();
        let trace = artifact.join("trace.vcd");
        fs::write(&trace, "trace fixture").unwrap();
        let run: SimulationRun = serde_json::from_value(serde_json::json!({
            "schema_version":SCHEMA,"id":format!("run-{name}"),"snapshot_id":name,"representation":"elaborated",
            "trace":trace,"trace_hash":file_hash(&trace).unwrap(),"dut_scope":["tb","dut"],"simulator":null,
            "diagnostics":[],"directory":artifact,"imported":false
        })).unwrap();
        let run_path = artifact.join("run.json");
        atomic_json(&run_path, &run).unwrap();
        (workspace, snapshot_path, run_path)
    }
    #[test]
    fn projects_restore_independently_and_detect_changed_working_inputs() {
        let d = tempfile::tempdir().unwrap();
        let store = d.path().join("cache");
        let (a, sa, ra) = fixture(d.path(), "a");
        let (b, sb, rb) = fixture(d.path(), "b");
        save(&store, &a, &sa, Some(&ra)).unwrap();
        save(&store, &b, &sb, Some(&rb)).unwrap();
        let restored = restore(&store, &a);
        assert_eq!(restored.snapshot.unwrap().id, "a");
        assert_eq!(restored.run_path, Some(ra));
        assert!(!restored.stale);
        assert_eq!(restore(&store, &b).snapshot.unwrap().id, "b");
        assert!(save(&store, &a, &sb, None).is_err());
        assert!(save(&store, &a, &sa, Some(&rb)).is_err());
        fs::write(
            a.path.parent().unwrap().join("top.v"),
            "module top; wire changed; endmodule",
        )
        .unwrap();
        assert!(restore(&store, &a).stale);
        assert!(read_snapshot(&sa).is_ok());
    }
    #[test]
    fn a_snapshot_of_another_schema_is_rejected_and_restores_as_a_warning() {
        let d = tempfile::tempdir().unwrap();
        let (workspace, snapshot_path, run_path) = fixture(d.path(), "old");
        let store = d.path().join("store");
        save(&store, &workspace, &snapshot_path, Some(&run_path)).unwrap();
        let mut value: serde_json::Value = read_json(&snapshot_path).unwrap();
        value["schema_version"] = (SCHEMA - 1).into();
        atomic_json(&snapshot_path, &value).unwrap();
        assert!(read_snapshot(&snapshot_path)
            .unwrap_err()
            .to_string()
            .contains("Unsupported snapshot schema"));
        let state = restore(&store, &workspace);
        assert!(state.snapshot.is_none());
        assert_eq!(state.warnings.len(), 1);
    }
    #[test]
    fn damaged_missing_and_mismatched_artifacts_recover_without_wrong_binding() {
        let d = tempfile::tempdir().unwrap();
        let store = d.path().join("cache");
        let (a, snapshot, run) = fixture(d.path(), "a");
        assert!(restore(&store, &a).snapshot.is_none());
        save(&store, &a, &snapshot, Some(&run)).unwrap();
        fs::write(run.parent().unwrap().join("trace.vcd"), "corrupted").unwrap();
        let state = restore(&store, &a);
        assert!(state.snapshot.is_some());
        assert!(state.run_path.is_none());
        assert_eq!(state.warnings.len(), 1);
        fs::remove_file(&snapshot).unwrap();
        let state = restore(&store, &a);
        assert!(state.snapshot.is_none());
        assert_eq!(state.warnings.len(), 1);
        fs::write(state_path(&store, &a.path), "invalid JSON").unwrap();
        assert_eq!(restore(&store, &a).warnings.len(), 1);
    }
}
