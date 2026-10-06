use crate::{model::*, project::*, runner::*, workspace};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, path::Path};

const RULES: &str =
    "no-trailing-spaces,posix-eof,forbid-consecutive-null-statements,module-port,module-parameter";
const LIMIT: usize = 1000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum LintContext {
    Design,
    Simulation { configuration: Option<String> },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkingBuffer {
    pub file: FileRef,
    pub text: String,
    pub version: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EditorLintRequest {
    pub path: String,
    pub active_file: FileRef,
    pub context: LintContext,
    pub buffers: Vec<WorkingBuffer>,
    pub profile: ToolchainProfile,
    pub generation: u64,
    pub style: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EditorLocation {
    pub file: FileRef,
    pub from: usize,
    pub to: usize,
    pub line: usize,
    pub column: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EditorDiagnostic {
    #[serde(flatten)]
    pub location: Option<EditorLocation>,
    pub severity: String,
    pub engine: String,
    pub code: String,
    pub message: String,
    pub related: Vec<RelatedDiagnostic>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RelatedDiagnostic {
    #[serde(flatten)]
    pub location: Option<EditorLocation>,
    pub message: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EngineStatus {
    pub engine: String,
    pub status: String,
    pub message: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CheckedFile {
    pub file: FileRef,
    pub text_hash: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EditorLintResult {
    pub generation: u64,
    pub project_fingerprint: String,
    pub files: Vec<CheckedFile>,
    pub engines: Vec<EngineStatus>,
    pub diagnostics: Vec<EditorDiagnostic>,
    pub limited: bool,
    pub truncated: bool,
}
#[derive(Deserialize)]
struct RawLocation {
    file: String,
    offset: usize,
}
#[derive(Deserialize)]
struct RawRange {
    file: String,
    start: usize,
    end: usize,
}
#[derive(Deserialize)]
struct RawDiagnostic {
    location: Option<RawLocation>,
    ranges: Vec<RawRange>,
    severity: String,
    code: String,
    message: String,
    related: Vec<RawRelated>,
}
#[derive(Deserialize)]
struct RawRelated {
    location: Option<RawLocation>,
    message: String,
}
#[derive(Deserialize)]
struct RawResult {
    diagnostics: Vec<RawDiagnostic>,
    files: Vec<String>,
}
struct LintFile {
    reference: FileRef,
    text: String,
}

fn auxiliary_only(project: &ProjectConfig, file: &FileRef) -> bool {
    let source = project.sources.iter().any(|source| &source.path == file)
        || project.headers.contains(file)
        || project.simulation_sources.contains(file)
        || project.simulation_headers.contains(file)
        || project
            .simulations
            .values()
            .any(|config| config.testbench.contains(file));
    !source
        && (project.assets.contains(file)
            || project
                .imports
                .iter()
                .any(|record| &record.location == file)
            || project
                .simulations
                .values()
                .any(|config| config.models.contains(file)))
}

/// Scratch inputs never become snapshots. Only the most recent tool logs survive.
struct Scratch<'a>(&'a Path);
impl Drop for Scratch<'_> {
    fn drop(&mut self) {
        if let Ok(entries) = fs::read_dir(self.0) {
            for entry in entries.flatten() {
                if entry.file_name() == "logs" {
                    continue;
                }
                let path = entry.path();
                let _ = if path.is_dir() {
                    fs::remove_dir_all(path)
                } else {
                    fs::remove_file(path)
                };
            }
        }
    }
}

pub fn validate(
    workspace: &workspace::WorkspaceProject,
    request: &EditorLintRequest,
) -> Result<()> {
    for file in std::iter::once(&request.active_file).chain(request.buffers.iter().map(|b| &b.file))
    {
        if hdl_language(file.path()).is_none() {
            bail!("Only working Verilog/SystemVerilog files can be linted")
        }
        if auxiliary_only(&workspace.project, file) {
            bail!("Auxiliary files are excluded from live linting")
        }
        workspace::read_document(workspace, file)?;
    }
    if let LintContext::Simulation {
        configuration: Some(name),
    } = &request.context
    {
        if !workspace.project.simulations.contains_key(name) {
            bail!("Unknown lint simulation configuration {name}")
        }
    }
    let mut seen = BTreeMap::new();
    for buffer in &request.buffers {
        let path = resolve_reference(&workspace.path, &workspace.project, &buffer.file)?;
        if seen
            .insert(path, &buffer.text)
            .is_some_and(|text| text != &buffer.text)
        {
            bail!("Conflicting buffers for the same working file")
        }
        if buffer.text.contains(['\0', '\r']) {
            bail!("Lint buffers must contain normalized UTF-8 text")
        }
    }
    Ok(())
}

pub fn lint(
    workspace: &workspace::WorkspaceProject,
    request: EditorLintRequest,
    store: &Path,
    cancel: CancelToken,
) -> Result<EditorLintResult> {
    validate(workspace, &request)?;
    cancel.check()?;
    let directory = store.join("editor-lint");
    if directory.exists() {
        fs::remove_dir_all(&directory)?;
    }
    fs::create_dir_all(&directory)?;
    let directory = directory.canonicalize()?;
    let _scratch = Scratch(&directory);
    let mut project = workspace.project.clone();
    let configuration = match &request.context {
        LintContext::Design => None,
        LintContext::Simulation { configuration } => configuration
            .as_ref()
            .map(|name| workspace.project.simulations[name].clone()),
    };
    if matches!(request.context, LintContext::Design) {
        project.simulation_sources.clear();
        project.simulation_headers.clear();
    } else {
        project.simulation_sources = configuration
            .as_ref()
            .map(|c| c.testbench.clone())
            .unwrap_or_else(|| project.simulation_sources.clone());
        project.top = configuration
            .as_ref()
            .map(|c| c.top.clone())
            .unwrap_or_default();
        project.parameters.clear();
        project.standard = if project.standard.starts_with("1364") {
            "1800-2017".into()
        } else {
            project.standard.clone()
        };
        if let Some(config) = &configuration {
            project.defines.extend(config.defines.clone());
        }
    }
    project.simulations.clear();
    project.assets.clear();
    project.physical = None;
    project.imports.clear();
    // Buffers from other contexts are captured for includes, never added as compilation units.
    for buffer in &request.buffers {
        if !workspace::project_files(&project).contains(&buffer.file) {
            project.headers.push(buffer.file.clone());
        }
    }
    let captured = capture_cancellable(&workspace.path, &project, &directory, &cancel)?;
    let mut files = BTreeMap::new();
    for (logical, original) in &captured.origins {
        cancel.check()?;
        if hdl_language(Path::new(logical)).is_none() {
            continue;
        }
        let reference = if let Some(path) = logical.strip_prefix("__roots/") {
            let (root, path) = path.split_once('/').context("Invalid captured root")?;
            FileRef::Rooted {
                root: root.into(),
                path: path.into(),
            }
        } else {
            FileRef::Local(logical.into())
        };
        let path = directory.join("inputs").join(logical);
        let bytes = fs::read(&path)
            .with_context(|| format!("Read captured lint input {}", path.display()))?;
        let text = std::str::from_utf8(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes))
            .with_context(|| format!("Unsupported encoding in {}", original.display()))?
            .replace("\r\n", "\n");
        if text.contains(['\r', '\0']) {
            bail!(
                "Unsupported text encoding or line endings in {}",
                original.display()
            )
        }
        let mut text = text;
        for buffer in &request.buffers {
            if resolve_reference(&workspace.path, &workspace.project, &buffer.file)? == *original {
                text.clone_from(&buffer.text);
            }
        }
        fs::write(&path, &text)?;
        files.insert(
            path.to_string_lossy().into_owned(),
            LintFile { reference, text },
        );
    }
    let inputs = directory.join("inputs");
    let mut units: Vec<String> = captured
        .project
        .sources
        .iter()
        .map(|s| inputs.join(&s.path).to_string_lossy().into_owned())
        .collect();
    units.extend(
        captured
            .project
            .simulation_sources
            .iter()
            .map(|f| inputs.join(f).to_string_lossy().into_owned()),
    );
    let mut top = captured.project.top.clone();
    if let Some(config) = &configuration {
        if !workspace.project.parameters.is_empty() {
            let overrides = crate::simulation::rtl_parameter_overrides(&workspace.project, config)?;
            let harness = directory.join("lint-top.sv");
            fs::write(
                &harness,
                format!(
                    "module hdlview_lint; {} {}();\n{overrides}endmodule\n",
                    config.top, config.top
                ),
            )?;
            units.push(harness.to_string_lossy().into_owned());
            top = "hdlview_lint".into();
        }
    }
    let mut result = EditorLintResult {
        generation: request.generation,
        project_fingerprint: hash(serde_json::to_vec(&workspace.project)?),
        files: files
            .values()
            .map(|f| CheckedFile {
                file: f.reference.clone(),
                text_hash: hash(&f.text),
            })
            .collect(),
        engines: vec![],
        diagnostics: vec![],
        limited: top.is_empty(),
        truncated: false,
    };
    let mut profile = request.profile;
    profile.timeout_seconds = profile.timeout_seconds.min(10);
    let runner = Runner::new(profile, directory.clone(), cancel.clone());
    let helper = directory.join("editor_lint.py");
    fs::write(&helper, include_str!("../../../tools/editor_lint.py"))?;
    let parameters = directory.join("lint-request.json");
    let output = directory.join("lint-result.json");
    atomic_json(
        &parameters,
        &serde_json::json!({
            "files":units,"top":top,"standard":captured.project.standard,
            "include_dirs":captured.project.include_dirs.iter().map(|p| inputs.join(p)).collect::<Vec<_>>(),
            "defines":captured.project.defines,"parameters":captured.project.parameters,
        }),
    )?;
    let semantic = if units.is_empty() {
        Ok(RawResult {
            diagnostics: vec![],
            files: vec![],
        })
    } else {
        runner
            .run(
                "python3",
                &[
                    helper.to_string_lossy().into_owned(),
                    parameters.to_string_lossy().into_owned(),
                    output.to_string_lossy().into_owned(),
                ],
                &directory,
                "pyslang",
            )
            .and_then(|_| read_json::<RawResult>(&output))
    };
    cancel.check()?;
    match semantic {
        Ok(raw) => {
            let active = request.active_file.logical();
            let included = raw
                .files
                .iter()
                .any(|file| Path::new(file) == inputs.join(&active));
            let header = request
                .active_file
                .path()
                .extension()
                .is_some_and(|extension| {
                    extension.eq_ignore_ascii_case("vh") || extension.eq_ignore_ascii_case("svh")
                });
            if header && !included {
                result.limited = true;
            }
            let message = if header && !included {
                Some("Header is not included in this analysis context; style checks remain available".into())
            } else if result.limited {
                Some("Limited analysis: configure a top or select a simulation configuration for semantic checks".into())
            } else if configuration
                .as_ref()
                .is_some_and(|c| c.simulator == Simulator::Icarus)
            {
                Some("Slang checks SystemVerilog-2017/2023; Icarus compiles SystemVerilog-2012. Simulator compilation remains authoritative for compatibility".into())
            } else {
                None
            };
            result.engines.push(EngineStatus {
                engine: "slang".into(),
                status: if result.limited
                    || configuration
                        .as_ref()
                        .is_some_and(|c| c.simulator == Simulator::Icarus)
                {
                    "limited"
                } else {
                    "complete"
                }
                .into(),
                message,
            });
            for raw in raw.diagnostics {
                let location = raw.location.as_ref().and_then(|loc| {
                    let file = files.get(&loc.file)?;
                    let range = raw
                        .ranges
                        .iter()
                        .find(|r| {
                            r.file == loc.file && r.start <= loc.offset && r.end >= loc.offset
                        })
                        .or_else(|| raw.ranges.iter().find(|r| r.file == loc.file));
                    Some(span(
                        file,
                        range.map_or(loc.offset, |r| r.start),
                        range.map_or(loc.offset, |r| r.end),
                    ))
                });
                if raw.severity == "note" {
                    if let Some(previous) = result.diagnostics.last_mut() {
                        previous.related.push(RelatedDiagnostic {
                            location,
                            message: raw.message,
                        });
                        continue;
                    }
                }
                result.diagnostics.push(EditorDiagnostic {
                    location,
                    severity: if raw.severity == "note" {
                        "info".into()
                    } else {
                        raw.severity
                    },
                    engine: "slang".into(),
                    code: raw.code,
                    message: raw.message,
                    related: raw
                        .related
                        .into_iter()
                        .map(|related| RelatedDiagnostic {
                            location: related.location.and_then(|loc| {
                                files
                                    .get(&loc.file)
                                    .map(|file| span(file, loc.offset, loc.offset))
                            }),
                            message: related.message,
                        })
                        .collect(),
                });
            }
        }
        Err(error) => result.engines.push(failed("slang", error)),
    }
    if request.style && !files.is_empty() {
        let style = (|| -> Result<String> {
            let mut args = vec![
                "--ruleset=none".into(),
                "--autofix=no".into(),
                "--lint_fatal=false".into(),
                "--parse_fatal=false".into(),
            ];
            let rules = workspace
                .path
                .parent()
                .context("Project directory missing")?
                .join(".rules.verible_lint");
            if rules.exists() {
                let copy = directory.join("rules.verible_lint");
                fs::copy(&rules, &copy)?;
                args.push(format!("--rules_config={}", copy.display()));
            } else {
                args.push(format!("--rules={RULES}"));
            }
            let members = workspace::project_files(&workspace.project);
            args.extend(
                files
                    .iter()
                    .filter(|(_, file)| {
                        !auxiliary_only(&workspace.project, &file.reference)
                            && (members.contains(&file.reference)
                                || validate_hdl(&file.reference, true).is_ok())
                    })
                    .map(|(path, _)| path.clone()),
            );
            runner.run("verible-verilog-lint", &args, &directory, "verible")
        })();
        match style {
            Ok(log) => {
                if log.contains("[ERR]") || log.contains("Invalid flag") {
                    result.engines.push(failed(
                        "verible",
                        anyhow::anyhow!("Invalid .rules.verible_lint configuration: {log}"),
                    ));
                } else {
                    let mut incomplete = false;
                    for line in log.lines().filter(|l| !l.trim().is_empty()) {
                        if let Some((path, line_number, column, end, message)) = verible_line(line)
                        {
                            let Some(file) = files.get(path) else {
                                incomplete = true;
                                continue;
                            };
                            if message.contains("syntax error") || !message.ends_with(']') {
                                incomplete = true;
                                continue;
                            }
                            let code = message
                                .rsplit_once('[')
                                .map(|(_, c)| c.trim_end_matches(']'))
                                .context("Missing style code")?;
                            let start = byte_column(&file.text, line_number, column);
                            let end = byte_column(&file.text, line_number, end.saturating_add(1));
                            result.diagnostics.push(EditorDiagnostic {
                                location: Some(span(file, start, end)),
                                severity: "warning".into(),
                                engine: "verible".into(),
                                code: code.into(),
                                message: message.into(),
                                related: vec![],
                            });
                        } else {
                            incomplete = true;
                        }
                    }
                    result.engines.push(EngineStatus { engine: "verible".into(), status: if incomplete { "limited" } else { "complete" }.into(), message: incomplete.then(|| "Style analysis is incomplete: Verible could not parse some input or diagnostic output; inspect the lint log".into()) });
                }
            }
            Err(error) => result.engines.push(failed("verible", error)),
        }
    } else {
        result.engines.push(EngineStatus {
            engine: "verible".into(),
            status: "disabled".into(),
            message: None,
        });
    }
    cancel.check()?;
    result.limited |= result
        .engines
        .iter()
        .any(|e| matches!(e.status.as_str(), "failed" | "limited"));
    result.diagnostics.sort_by_key(|d| {
        (
            if d.severity == "error" { 0 } else { 1 },
            d.location.as_ref().map(|l| (l.file.clone(), l.from)),
            d.engine.clone(),
            d.code.clone(),
        )
    });
    result.diagnostics.dedup_by(|a, b| {
        a.engine == b.engine
            && a.code == b.code
            && a.message == b.message
            && a.location.as_ref().map(|l| (&l.file, l.from, l.to))
                == b.location.as_ref().map(|l| (&l.file, l.from, l.to))
    });
    result.truncated = result.diagnostics.len() > LIMIT;
    result.diagnostics.truncate(LIMIT);
    Ok(result)
}
fn failed(engine: &str, error: anyhow::Error) -> EngineStatus {
    EngineStatus {
        engine: engine.into(),
        status: "failed".into(),
        message: Some(format!("{error:#}")),
    }
}
fn span(file: &LintFile, start: usize, end: usize) -> EditorLocation {
    let mut start = start.min(file.text.len());
    while !file.text.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = end.max(start).min(file.text.len());
    while !file.text.is_char_boundary(end) {
        end -= 1;
    }
    if start == end && end < file.text.len() {
        end += file.text[end..].chars().next().map_or(0, char::len_utf8);
    }
    let prefix = &file.text[..start];
    EditorLocation {
        file: file.reference.clone(),
        from: prefix.encode_utf16().count(),
        to: file.text[..end].encode_utf16().count(),
        line: prefix.bytes().filter(|c| *c == b'\n').count() + 1,
        column: prefix
            .rsplit('\n')
            .next()
            .unwrap_or("")
            .encode_utf16()
            .count()
            + 1,
    }
}
fn byte_column(text: &str, line: usize, column: usize) -> usize {
    let start: usize = text
        .split_inclusive('\n')
        .take(line.saturating_sub(1))
        .map(str::len)
        .sum();
    let length = text[start..].split('\n').next().map_or(0, str::len);
    start + column.saturating_sub(1).min(length)
}
fn verible_line(line: &str) -> Option<(&str, usize, usize, usize, &str)> {
    for (at, _) in line.match_indices(": ") {
        let mut fields = line[..at].rsplitn(3, ':');
        let (Some(columns), Some(number), Some(path)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let number = number.parse().ok();
        let (start, end) = columns.split_once('-').unwrap_or((columns, columns));
        if let (Some(number), Ok(start), Ok(end)) = (number, start.parse(), end.parse()) {
            return Some((path, number, start, end, &line[at + 2..]));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn utf16_ranges_include_unicode_and_eof() {
        let file = LintFile {
            reference: "rtl/test.sv".into(),
            text: "é😀\nmissing".into(),
        };
        let location = span(&file, 7, 14);
        assert_eq!(
            (location.from, location.to, location.line, location.column),
            (4, 11, 2, 1)
        );
        assert_eq!(span(&file, 14, 99).from, 11);
        assert_eq!(byte_column(&file.text, 2, 1), 7);
    }
    #[test]
    fn style_locations_preserve_spaces_colons_and_inclusive_end() {
        assert_eq!(verible_line("/rtl: old/top.sv:2:4-6: Remove spaces. [Style: trailing-spaces] [no-trailing-spaces]"), Some(("/rtl: old/top.sv", 2, 4, 6, "Remove spaces. [Style: trailing-spaces] [no-trailing-spaces]")));
        assert!(verible_line("configuration failed").is_none());
    }
    #[cfg(unix)]
    #[test]
    fn engine_timeout_is_not_a_clean_result_and_removes_inputs() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let mut workspace = workspace::create(
            &directory.path().join("hdlview.project.json"),
            "lint timeout".into(),
            false,
        )
        .unwrap();
        fs::write(directory.path().join("top.sv"), "module top; endmodule\n").unwrap();
        workspace.project.top = "top".into();
        workspace.project.sources.push(SourceFile {
            path: "top.sv".into(),
            language: Language::SystemVerilog,
        });
        let executable = directory.path().join("slow-python");
        fs::write(&executable, "#!/bin/sh\nexec sleep 30\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let profile = ToolchainProfile {
            timeout_seconds: 1,
            executables: BTreeMap::from([(
                "python3".into(),
                executable.to_string_lossy().into_owned(),
            )]),
            ..Default::default()
        };
        let store = tempfile::tempdir().unwrap();
        let started = std::time::Instant::now();
        let result = lint(
            &workspace,
            EditorLintRequest {
                path: workspace.path.to_string_lossy().into_owned(),
                active_file: "top.sv".into(),
                context: LintContext::Design,
                buffers: vec![],
                profile,
                generation: 1,
                style: false,
            },
            store.path(),
            CancelToken::default(),
        )
        .unwrap();
        assert!(result.limited && result.diagnostics.is_empty());
        assert_eq!(result.engines[0].status, "failed");
        assert!(result.engines[0]
            .message
            .as_ref()
            .unwrap()
            .contains("timed out"));
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        let remaining: Vec<_> = fs::read_dir(store.path().join("editor-lint"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(remaining, vec!["logs"]);
        assert_eq!(
            fs::read_to_string(directory.path().join("top.sv")).unwrap(),
            "module top; endmodule\n"
        );
    }
}
