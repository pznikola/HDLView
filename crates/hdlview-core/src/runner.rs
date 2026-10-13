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
const PROBED: [&str; 8] = [
    "yosys",
    "iverilog",
    "vvp",
    "verilator",
    "verible-verilog-lint",
    "python3",
    "librelane",
    "openroad",
];
/// The IIC-OSIC-TOOLS release HDLView is qualified with.
pub const QUALIFIED_IMAGE: &str = "hpretl/iic-osic-tools:2026.09";
/// Where a container sees the workspace when the host path is not a valid path there.
const CONTAINER_ROOT: &str = "/hdlview/work";
/// The path a container is given for a host path: one under `root` moves under
/// the container's workspace, any other path only gets forward slashes.
fn container_path(root: &Path, path: &Path) -> String {
    match path.strip_prefix(root) {
        Ok(inside) if inside.as_os_str().is_empty() => CONTAINER_ROOT.into(),
        Ok(inside) => format!(
            "{CONTAINER_ROOT}/{}",
            inside.to_string_lossy().replace('\\', "/")
        ),
        Err(_) => path.to_string_lossy().replace('\\', "/"),
    }
}
/// The host path of a path a tool wrote, where `root` is the workspace it ran in.
pub fn host_path(root: &Path, text: &str) -> PathBuf {
    match text.strip_prefix(CONTAINER_ROOT) {
        Some("") => root.into(),
        Some(inside) if inside.starts_with('/') => root.join(&inside[1..]),
        _ => text.into(),
    }
}
/// The first IIC-OSIC-TOOLS release with LibreLane 3.
const OLDEST_IMAGE: &str = "2026.08";
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolchainState {
    Ready,
    DockerMissing,
    DockerStopped,
    ImageMissing,
    ImageOld,
    Unsupported,
}
/// Whether the profile's tools can be started, and what the user must do when they cannot.
#[derive(Debug, Clone, Serialize)]
pub struct ToolchainStatus {
    pub state: ToolchainState,
    pub message: String,
    pub commands: Vec<String>,
    pub link: Option<String>,
    /// The immutable identity of a Docker profile's image.
    #[serde(skip)]
    image: Option<String>,
}
impl ToolchainStatus {
    fn new(state: ToolchainState, message: &str, commands: &[String], link: Option<&str>) -> Self {
        Self {
            state,
            message: message.into(),
            commands: commands.to_vec(),
            link: link.map(Into::into),
            image: None,
        }
    }
    fn error(&self) -> anyhow::Error {
        let mut text = self.message.clone();
        for command in &self.commands {
            text.push_str(&format!("\n  {command}"));
        }
        anyhow::anyhow!(text)
    }
}
/// A command that opens no console window when the desktop application starts it.
pub(crate) fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW
        command.creation_flags(0x0800_0000);
    }
    command
}
pub fn toolchain_status(profile: &ToolchainProfile) -> ToolchainStatus {
    use ToolchainState::*;
    if matches!(profile.provider, Provider::Native) {
        return if cfg!(windows) {
            ToolchainStatus::new(
                Unsupported,
                "Only the Docker toolchain is supported on Windows. Select a Docker profile in Toolchain.",
                &[],
                None,
            )
        } else {
            ToolchainStatus::new(Ready, "", &[], None)
        };
    }
    let docker = |args: &[&str]| {
        command(profile.exe("docker"))
            .args(args)
            .stdin(Stdio::null())
            .output()
    };
    let Ok(daemon) = docker(&["version", "--format", "{{.Server.Version}}"]) else {
        return ToolchainStatus::new(
            DockerMissing,
            "Docker is not installed.",
            &[],
            Some(if cfg!(windows) {
                "https://docs.docker.com/desktop/setup/install/windows-install/"
            } else {
                "https://docs.docker.com/engine/install/"
            }),
        );
    };
    if !daemon.status.success() {
        return if cfg!(windows) {
            ToolchainStatus::new(
                DockerStopped,
                "Docker Desktop is not running. Start it and wait until it reports that it is running.",
                &[],
                None,
            )
        } else {
            ToolchainStatus::new(
                DockerStopped,
                "The Docker service is not running, or your user may not use it. Start the service; if that is not enough, add your user to the docker group, then log out and in.",
                &[
                    "sudo systemctl start docker".into(),
                    "sudo usermod -aG docker $USER".into(),
                ],
                None,
            )
        };
    }
    let image = profile.image.clone().unwrap_or_default();
    let found = docker(&[
        "image",
        "inspect",
        "--format",
        "{{.Id}} {{index .Config.Labels \"org.opencontainers.image.version\"}}",
        &image,
    ])
    .ok()
    .filter(|output| output.status.success())
    .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
    .filter(|text| text.starts_with("sha256:"));
    let Some(found) = found else {
        return if image.is_empty() {
            ToolchainStatus::new(
                ImageMissing,
                "The Docker profile names no image. Set one in Toolchain.",
                &[],
                None,
            )
        } else {
            ToolchainStatus::new(
                ImageMissing,
                &format!("The tools image {image} is not downloaded. The download is about 4 GB and needs about 20 GB of free disk space."),
                &[format!("docker pull {image}")],
                None,
            )
        };
    };
    let (id, release) = found.split_once(' ').unwrap_or((&found, ""));
    // Releases are named year.month, so they order as text. An image without the label is not judged.
    if !release.is_empty() && release < OLDEST_IMAGE {
        return ToolchainStatus::new(
            ImageOld,
            &format!("The IIC-OSIC-TOOLS image {image} (release {release}) is too old for HDLView. Download the qualified release and select it in Toolchain."),
            &[format!("docker pull {QUALIFIED_IMAGE}")],
            None,
        );
    }
    let mut status = ToolchainStatus::new(Ready, "", &[], None);
    status.image = Some(id.into());
    status
}
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
    let status = toolchain_status(&profile);
    if status.state != ToolchainState::Ready {
        return Err(status.error());
    }
    if matches!(profile.provider, Provider::Docker) {
        profile.image = status.image;
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
                env.entry("PATH".into()).or_insert("/foss/tools/bin:/foss/tools/klayout:/foss/tools/sak:/usr/local/bin:/usr/bin:/bin".into());
                env.entry("LD_LIBRARY_PATH".into()).or_insert(
                    "/foss/tools/iverilog/lib:/foss/tools/gtkwave/lib/x86_64-linux-gnu".into(),
                );
                env.entry("CCACHE_DIR".into())
                    .or_insert_with(|| self.tool_path(&self.workspace.join("tool-cache/ccache")));
                env.entry("XDG_CACHE_HOME".into())
                    .or_insert_with(|| self.tool_path(&self.workspace.join("tool-cache")));
                let mount = |path: &Path, access: &str| {
                    format!(
                        "type=bind,src={},dst={}{access}",
                        path.display(),
                        self.tool_path(path)
                    )
                };
                let mut a = vec![
                    "run".into(),
                    "--rm".into(),
                    "--init".into(),
                    "--network=none".into(),
                    "--name".into(),
                    container.clone(),
                ];
                // Docker Desktop on Windows gives the files to the host user itself.
                #[cfg(unix)]
                a.extend([
                    "--user".into(),
                    format!("{}:{}", unsafe { libc::getuid() }, unsafe {
                        libc::getgid()
                    }),
                ]);
                a.extend([
                    "--workdir".into(),
                    self.tool_path(cwd),
                    "--mount".into(),
                    mount(&self.workspace, ""),
                ]);
                let inputs = self.workspace.join("inputs");
                if inputs.exists() {
                    a.extend(["--mount".into(), mount(&inputs, ",readonly")]);
                }
                if let Some(pdk) = &self.profile.pdk_root {
                    if pdk.exists() && !pdk.starts_with(&self.workspace) {
                        a.extend(["--mount".into(), mount(pdk, ",readonly")]);
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
        let mut cmd = command(&program);
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
        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(error) => {
                self.setup()?;
                return Err(error).with_context(|| {
                    format!("Cannot start {tool} ({program}); check toolchain profile")
                });
            }
        };
        let started = Instant::now();
        let status = loop {
            if self.cancel.check().is_err()
                || started.elapsed() > Duration::from_secs(self.profile.timeout_seconds)
            {
                if matches!(self.profile.provider, Provider::Docker) {
                    let _ = command(self.profile.exe("docker"))
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
            // Docker reports its own failures, such as a missing image, with this code.
            if matches!(self.profile.provider, Provider::Docker) && status.code() == Some(125) {
                self.setup()?;
            }
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
    /// Whether tools see the workspace under another path than the host does. A
    /// Linux container cannot mount a Windows path at itself; the variable lets
    /// that mapping be qualified on Linux.
    fn container_paths(&self) -> bool {
        matches!(self.profile.provider, Provider::Docker)
            && (cfg!(windows) || std::env::var_os("HDLVIEW_CONTAINER_PATHS").is_some())
    }
    /// The path to give a tool, in an argument or a generated file, for a host path.
    pub fn tool_path(&self, path: &Path) -> String {
        if self.container_paths() {
            container_path(&self.workspace, path)
        } else {
            path.to_string_lossy().into()
        }
    }
    /// The host path of a path a tool wrote.
    pub fn host_path(&self, text: &str) -> PathBuf {
        host_path(&self.workspace, text)
    }
    /// Replaces every path a tool wrote in a JSON document by its host path.
    pub fn host_paths(&self, value: &mut serde_json::Value) {
        use serde_json::Value;
        match value {
            Value::String(text) if text.starts_with(CONTAINER_ROOT) => {
                *text = self.host_path(text).to_string_lossy().into()
            }
            Value::Array(items) => items.iter_mut().for_each(|item| self.host_paths(item)),
            Value::Object(fields) => fields.values_mut().for_each(|item| self.host_paths(item)),
            _ => {}
        }
    }
    /// Fails with the setup instructions when the toolchain itself cannot be started.
    fn setup(&self) -> Result<()> {
        let status = toolchain_status(&self.profile);
        if status.state != ToolchainState::Ready {
            return Err(status.error());
        }
        Ok(())
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
    /// The setup status and, when the tools can be started, what each one reports.
    pub fn check(&self) -> serde_json::Value {
        let status = toolchain_status(&self.profile);
        let mut tools = BTreeMap::new();
        if status.state == ToolchainState::Ready {
            tools = self.probe();
            let root = crate::pipeline::pdk_root(&self.profile);
            for (pdk, _, file) in crate::pipeline::LIBERTY {
                let found = self.run(
                    "ls",
                    &[self.tool_path(&root.join(file))],
                    &self.workspace,
                    "probe-pdk",
                );
                let state = match found {
                    Ok(_) => "installed".into(),
                    Err(_) => format!("unavailable: not found under {}", root.display()),
                };
                tools.insert(format!("PDK {pdk}"), state);
            }
        }
        serde_json::json!({ "status": status, "tools": tools })
    }
    pub fn probe(&self) -> BTreeMap<String, String> {
        let versions: BTreeMap<String, String> = [
            ("yosys", vec!["-V"]),
            ("iverilog", vec!["-V"]),
            ("vvp", vec!["-V"]),
            ("verilator", vec!["--version"]),
            ("verible-verilog-lint", vec!["--version"]),
            ("python3", vec!["-c", "import pyslang; from importlib.metadata import version; installed = version('pyslang'); assert installed.split('.')[0] in ('10', '11'), f'Configured Python has pyslang {installed}; HDLView requires 10 or 11. Update the selected tools image or native Python environment.'; assert hasattr(getattr(pyslang, 'driver', pyslang).Driver, 'runAnalysis') and hasattr(pyslang.SourceManager, 'getFullyOriginalLoc'); print('pyslang', installed)"]),
            ("librelane", vec!["--version"]),
            ("openroad", vec!["-version"]),
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
    fn container_paths_round_trip() {
        for root in [
            Path::new("/home/user/store/design"),
            Path::new("C:\\store\\design"),
        ] {
            assert_eq!(container_path(root, root), "/hdlview/work");
            let inside = container_path(root, &root.join("inputs").join("top.sv"));
            assert_eq!(inside, "/hdlview/work/inputs/top.sv");
            assert_eq!(host_path(root, &inside), root.join("inputs/top.sv"));
            assert_eq!(host_path(root, "/hdlview/work"), root);
        }
        let root = Path::new("/home/user/store/design");
        assert_eq!(
            container_path(root, Path::new("/foss/pdks\\sky130A")),
            "/foss/pdks/sky130A"
        );
        assert_eq!(
            host_path(root, "/foss/pdks/a.lib"),
            Path::new("/foss/pdks/a.lib")
        );
        assert_eq!(
            host_path(root, "/hdlview/workshop"),
            Path::new("/hdlview/workshop")
        );
    }
    #[cfg(unix)]
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
    #[cfg(unix)]
    #[test]
    fn setup_status_names_what_is_missing() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let state = |script: Option<&str>| {
            let docker = d.path().join("docker");
            let _ = fs::remove_file(&docker);
            if let Some(script) = script {
                fs::write(&docker, format!("#!/bin/sh\n{script}\n")).unwrap();
                fs::set_permissions(&docker, fs::Permissions::from_mode(0o755)).unwrap();
            }
            let mut profile = ToolchainProfile {
                provider: Provider::Docker,
                image: Some("tools:1".into()),
                ..Default::default()
            };
            profile
                .executables
                .insert("docker".into(), docker.to_string_lossy().into());
            (toolchain_status(&profile), resolve_profile(profile))
        };
        assert_eq!(state(None).0.state, ToolchainState::DockerMissing);
        assert_eq!(state(Some("exit 1")).0.state, ToolchainState::DockerStopped);
        let (missing, resolved) = state(Some("[ \"$1\" = version ]"));
        assert_eq!(missing.state, ToolchainState::ImageMissing);
        assert_eq!(missing.commands, ["docker pull tools:1"]);
        assert!(format!("{:#}", resolved.unwrap_err()).contains("docker pull tools:1"));
        let image = |release: &str| format!("[ \"$1\" = version ] || echo sha256:abc {release}");
        let old = state(Some(&image("2025.12"))).0;
        assert_eq!(old.state, ToolchainState::ImageOld);
        assert_eq!(old.commands, [format!("docker pull {QUALIFIED_IMAGE}")]);
        for release in ["2026.09", ""] {
            let (ready, resolved) = state(Some(&image(release)));
            assert_eq!(ready.state, ToolchainState::Ready);
            assert_eq!(resolved.unwrap().image.as_deref(), Some("sha256:abc"));
        }
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
