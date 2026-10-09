use crate::model::*;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);
/// Probe results per toolchain identity; starting six tools costs more than a small build.
static VERSIONS: Mutex<BTreeMap<String, BTreeMap<String, String>>> = Mutex::new(BTreeMap::new());
const PROBED: [&str; 6] = [
    "yosys",
    "iverilog",
    "verilator",
    "verible-verilog-lint",
    "python3",
    "librelane",
];
#[derive(Clone, Default)]
pub struct CancelToken(pub Arc<AtomicBool>);
impl CancelToken {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    pub fn check(&self) -> Result<()> {
        if self.0.load(Ordering::SeqCst) {
            bail!("Job cancelled")
        }
        Ok(())
    }
}
#[derive(Debug, Serialize, Deserialize)]
pub struct CommandRecord {
    pub executable: String,
    pub arguments: Vec<String>,
    pub environment: BTreeMap<String, String>,
    pub directory: PathBuf,
    pub exit_code: Option<i32>,
    pub elapsed_ms: u128,
}
pub struct Runner {
    pub profile: ToolchainProfile,
    pub workspace: PathBuf,
    pub cancel: CancelToken,
}
pub fn resolve_profile(mut profile: ToolchainProfile) -> Result<ToolchainProfile> {
    if matches!(profile.provider, Provider::Docker) {
        let image = profile
            .image
            .clone()
            .context("A Docker profile needs an image")?;
        let output = Command::new(profile.exe("docker"))
            .args(["image", "inspect", "--format", "{{.Id}}", &image])
            .output()
            .context("Cannot inspect configured Docker image")?;
        if !output.status.success() {
            bail!("Docker image is not available locally: {image}")
        }
        let id = String::from_utf8(output.stdout)?.trim().to_owned();
        if !id.starts_with("sha256:") {
            bail!("Docker returned an invalid image identity")
        }
        profile.image = Some(id);
    } else {
        for name in ["PATH", "LD_LIBRARY_PATH", "YOSYS_DATDIR"] {
            if let Ok(value) = std::env::var(name) {
                profile.env.entry(name.into()).or_insert(value);
            }
        }
    }
    Ok(profile)
}
impl Runner {
    pub fn new(profile: ToolchainProfile, workspace: PathBuf, cancel: CancelToken) -> Self {
        Self {
            profile,
            workspace,
            cancel,
        }
    }
    pub fn run(&self, tool: &str, args: &[String], cwd: &Path, label: &str) -> Result<String> {
        self.cancel.check()?;
        fs::create_dir_all(cwd)?;
        let seq = SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let logdir = self.workspace.join("logs");
        fs::create_dir_all(&logdir)?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos();
        let log = logdir.join(format!(
            "{stamp}-{}-{seq:04}-{label}.log",
            std::process::id()
        ));
        let output = File::create(&log)?;
        let mut env = self.profile.env.clone();
        let exe = self.profile.exe(tool);
        let container = format!("hdlview-{}-{seq}", std::process::id());
        let (program, arguments) = match self.profile.provider {
            Provider::Native => (exe, args.to_vec()),
            Provider::Docker => {
                env.entry("PATH".into()).or_insert("/opt/hdlview/magic/bin:/foss/tools/bin:/foss/tools/klayout:/foss/tools/sak:/usr/local/bin:/usr/bin:/bin".into());
                env.entry("LD_LIBRARY_PATH".into()).or_insert(
                    "/foss/tools/iverilog/lib:/foss/tools/gtkwave/lib/x86_64-linux-gnu".into(),
                );
                env.entry("CCACHE_DIR".into()).or_insert_with(|| {
                    self.workspace
                        .join("tool-cache/ccache")
                        .to_string_lossy()
                        .into()
                });
                env.entry("XDG_CACHE_HOME".into())
                    .or_insert_with(|| self.workspace.join("tool-cache").to_string_lossy().into());
                let root = self.workspace.to_string_lossy();
                let mut a = vec![
                    "run".into(),
                    "--rm".into(),
                    "--init".into(),
                    "--network=none".into(),
                    "--name".into(),
                    container.clone(),
                    "--user".into(),
                    format!("{}:{}", unsafe { libc::getuid() }, unsafe {
                        libc::getgid()
                    }),
                    "--workdir".into(),
                    cwd.to_string_lossy().into(),
                    "--mount".into(),
                    format!("type=bind,src={root},dst={root}"),
                ];
                let inputs = self.workspace.join("inputs");
                if inputs.exists() {
                    a.extend([
                        "--mount".into(),
                        format!(
                            "type=bind,src={},dst={},readonly",
                            inputs.display(),
                            inputs.display()
                        ),
                    ]);
                }
                if let Some(pdk) = &self.profile.pdk_root {
                    if pdk.exists() && !pdk.starts_with(&self.workspace) {
                        a.extend([
                            "--mount".into(),
                            format!(
                                "type=bind,src={},dst={},readonly",
                                pdk.display(),
                                pdk.display()
                            ),
                        ]);
                    }
                }
                for (k, v) in &env {
                    a.extend(["--env".into(), format!("{k}={v}")]);
                }
                a.extend([
                    "--entrypoint".into(),
                    exe,
                    self.profile
                        .image
                        .clone()
                        .context("A Docker profile needs an image")?,
                ]);
                a.extend_from_slice(args);
                (self.profile.exe("docker"), a)
            }
        };
        let mut record = CommandRecord {
            executable: program.clone(),
            arguments: arguments.clone(),
            environment: env.clone(),
            directory: cwd.into(),
            exit_code: None,
            elapsed_ms: 0,
        };
        let recordpath = log.with_extension("command.json");
        fs::write(&recordpath, serde_json::to_vec_pretty(&record)?)?;
        let mut cmd = Command::new(&program);
        cmd.args(&arguments)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(output.try_clone()?)
            .stderr(output);
        if matches!(self.profile.provider, Provider::Native) {
            cmd.envs(env);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let mut child = cmd
            .spawn()
            .with_context(|| format!("Cannot start {tool} ({program}); check toolchain profile"))?;
        let started = Instant::now();
        let status = loop {
            if self.cancel.check().is_err()
                || started.elapsed() > Duration::from_secs(self.profile.timeout_seconds)
            {
                if matches!(self.profile.provider, Provider::Docker) {
                    let _ = Command::new(self.profile.exe("docker"))
                        .args(["kill", &container])
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status();
                }
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
                let _ = child.kill();
                let _ = child.wait();
                record.elapsed_ms = started.elapsed().as_millis();
                fs::write(&recordpath, serde_json::to_vec_pretty(&record)?)?;
                self.cancel.check()?;
                bail!("{tool} timed out; log: {}", log.display());
            }
            if let Some(status) = child.try_wait()? {
                break status;
            }
            thread::sleep(Duration::from_millis(40));
        };
        record.exit_code = status.code();
        record.elapsed_ms = started.elapsed().as_millis();
        fs::write(recordpath, serde_json::to_vec_pretty(&record)?)?;
        let text = fs::read_to_string(&log).unwrap_or_default();
        if !status.success() {
            bail!(
                "{tool} failed ({status}); log: {}\n{}",
                log.display(),
                text.chars()
                    .rev()
                    .take(5000)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect::<String>()
            );
        }
        Ok(text)
    }
    /// Identifies the tools behind a resolved profile: a Docker image digest is
    /// already part of the profile; native executables add their size and
    /// modification time, so an updated tool is probed again.
    pub fn toolchain_key(&self) -> String {
        let mut files = Vec::new();
        if matches!(self.profile.provider, Provider::Native) {
            let search = self.profile.env.get("PATH").cloned().unwrap_or_default();
            let names = PROBED.iter().map(|tool| self.profile.exe(tool));
            for name in names.chain(self.profile.plugins.values().cloned()) {
                let file = if name.contains('/') {
                    Some(PathBuf::from(&name))
                } else {
                    std::env::split_paths(&search)
                        .map(|dir| dir.join(&name))
                        .find(|path| path.is_file())
                };
                let state = file
                    .and_then(|path| fs::metadata(path).ok())
                    .map(|data| (data.len(), data.modified().ok()));
                files.push((name, state));
            }
        }
        crate::project::hash(format!(
            "{}{files:?}",
            serde_json::to_string(&self.profile).unwrap_or_default()
        ))
    }
    /// Tool versions for a build, probed once per toolchain identity.
    pub fn versions(&self) -> BTreeMap<String, String> {
        let known = VERSIONS.lock().unwrap().get(&self.toolchain_key()).cloned();
        known.unwrap_or_else(|| self.probe())
    }
    pub fn probe(&self) -> BTreeMap<String, String> {
        let versions: BTreeMap<String, String> = [
            ("yosys", vec!["-V"]),
            ("iverilog", vec!["-V"]),
            ("verilator", vec!["--version"]),
            ("verible-verilog-lint", vec!["--version"]),
            ("python3", vec!["-c", "import pyslang; from importlib.metadata import version; installed = version('pyslang'); assert installed == '10.0.0', f'Configured Python has pyslang {installed}; HDLView requires 10.0.0. Update the selected tools image or native Python environment.'; assert hasattr(pyslang.Driver, 'runAnalysis') and hasattr(pyslang.SourceManager, 'getFullyOriginalLoc'); print('pyslang', installed)"]),
            ("librelane", vec!["--version"]),
        ]
        .into_iter()
        .map(|(tool, args)| {
            let text = self.run(
                tool,
                &args.into_iter().map(String::from).collect::<Vec<_>>(),
                &self.workspace,
                &format!("probe-{tool}"),
            );
            (
                tool.into(),
                match text {
                    Ok(s) => s.lines().take(4).collect::<Vec<_>>().join("\n"),
                    Err(e) => format!("unavailable: {e}"),
                },
            )
        })
        .collect();
        VERSIONS
            .lock()
            .unwrap()
            .insert(self.toolchain_key(), versions.clone());
        versions
    }
}

/// Yosys has its own lexer; shell quoting is not a substitute for this quoting.
pub fn yosys_quote(s: &str) -> Result<String> {
    if s.contains(['\n', '\r', '\0']) {
        bail!("Newline/NUL is not allowed in Yosys arguments")
    }
    Ok(format!(
        "\"{}\"",
        s.replace('\\', "\\\\").replace('"', "\\\"")
    ))
}
pub fn identifier(s: &str) -> Result<&str> {
    if s.is_empty()
        || !s
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_.$".contains(c))
    {
        bail!("Expected a simple HDL identifier, got {s:?}")
    }
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quoting() {
        assert_eq!(yosys_quote("a b; c\".sv").unwrap(), "\"a b; c\\\".sv\"");
        assert!(yosys_quote("a\nexec bad").is_err());
        assert!(identifier("x; exec bad").is_err());
    }
    #[test]
    fn versions_are_probed_once_per_toolchain_identity() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let tool = d.path().join("tool");
        fs::write(&tool, "#!/bin/sh\necho one\n").unwrap();
        fs::set_permissions(&tool, fs::Permissions::from_mode(0o755)).unwrap();
        let mut profile = ToolchainProfile::default();
        for name in PROBED {
            profile
                .executables
                .insert(name.into(), tool.to_string_lossy().into());
        }
        let runner =
            |name: &str| Runner::new(profile.clone(), d.path().join(name), CancelToken::default());
        fs::create_dir(d.path().join("first")).unwrap();
        assert_eq!(runner("first").versions()["yosys"], "one");
        assert_eq!(runner("second").versions()["yosys"], "one");
        assert!(!d.path().join("second").exists());
        fs::write(&tool, "#!/bin/sh\necho changed\n").unwrap();
        fs::create_dir(d.path().join("third")).unwrap();
        assert_eq!(runner("third").versions()["yosys"], "changed");
    }
    #[test]
    fn cancelled_before_spawn() {
        let d = tempfile::tempdir().unwrap();
        let c = CancelToken::default();
        c.cancel();
        let r = Runner::new(ToolchainProfile::default(), d.path().into(), c);
        assert!(r.run("true", &[], d.path(), "cancel").is_err());
    }
    #[test]
    fn native_failure_retains_log() {
        let d = tempfile::tempdir().unwrap();
        let r = Runner::new(
            ToolchainProfile::default(),
            d.path().into(),
            CancelToken::default(),
        );
        assert!(r.run("false", &[], d.path(), "failure").is_err());
        assert!(d.path().join("logs").exists());
    }
}
