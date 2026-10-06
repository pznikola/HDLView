import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { fileKey } from "./projects";
import type { EditorTab } from "./components/SourceEditor";
import type {
  EditorDiagnostic,
  EditorLintRequest,
  EditorLintResult,
  FileRef,
  Job,
  LintContext,
  Profile,
  Project,
  SourceDocument,
  WorkspaceProject,
} from "./types";

export interface LintPreferences {
  enabled: boolean;
  style: boolean;
}
export function lintContext(
  project: Project,
  file: FileRef,
  selected: string,
  override?: string,
): {
  context: LintContext;
  choices: string[];
} {
  const key = fileKey(file);
  if (
    project.sources.some((s) => fileKey(s.path) === key) ||
    project.headers?.some((f) => fileKey(f) === key)
  )
    return { context: { kind: "design" }, choices: [] };
  const header = /\.(vh|svh)$/i.test(
    typeof file === "string" ? file : file.path,
  );
  if (header && !project.simulation_headers?.some((f) => fileKey(f) === key))
    return { context: { kind: "design" }, choices: [] };
  const choices = Object.entries(project.simulations)
    .filter(([, c]) => header || c.testbench.some((f) => fileKey(f) === key))
    .map(([name]) => name);
  const configuration =
    override !== undefined
      ? choices.includes(override)
        ? override
        : null
      : choices.includes(selected)
        ? selected
        : choices.length === 1
          ? (choices[0] ?? null)
          : null;
  return { context: { kind: "simulation", configuration }, choices };
}
function preferences(path: string): LintPreferences {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(`hdlview-lint:${path}`) ?? "null",
    );
    if (
      isRecord(value) &&
      typeof value.enabled === "boolean" &&
      typeof value.style === "boolean"
    )
      return { enabled: value.enabled, style: value.style };
  } catch {
    /* Invalid local preferences use the documented defaults. */
  }
  return { enabled: true, style: true };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isFile(value: unknown): value is FileRef {
  return (
    typeof value === "string" ||
    (isRecord(value) &&
      typeof value.root === "string" &&
      typeof value.path === "string")
  );
}
function isLocation(value: Record<string, unknown>): boolean {
  return (
    value.file === undefined ||
    (isFile(value.file) &&
      [value.from, value.to, value.line, value.column].every(
        (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0,
      ) &&
      typeof value.from === "number" &&
      typeof value.to === "number" &&
      value.to >= value.from)
  );
}
function isDiagnostic(value: unknown): value is EditorDiagnostic {
  return (
    isRecord(value) &&
    isLocation(value) &&
    ["error", "warning", "info", "hint"].includes(String(value.severity)) &&
    [value.engine, value.code, value.message].every(
      (v) => typeof v === "string",
    ) &&
    Array.isArray(value.related) &&
    value.related.every(
      (r: unknown) =>
        isRecord(r) && isLocation(r) && typeof r.message === "string",
    )
  );
}
export function decodeLintResult(value: unknown): EditorLintResult {
  if (!isLintResult(value))
    throw new Error("Invalid editor diagnostic response");
  return value;
}
export function lintStatus(result: EditorLintResult): string {
  const slang = result.engines.find((engine) => engine.engine === "slang");
  const verible = result.engines.find((engine) => engine.engine === "verible");
  if (slang?.status === "failed") return "Correctness checks unavailable";
  if (slang?.status === "limited") return "Limited analysis";
  if (verible?.status === "failed") return "Style checks unavailable";
  if (verible?.status === "limited") return "Style checks incomplete";
  return result.limited ? "Limited analysis" : "Checked";
}
function isLintResult(value: unknown): value is EditorLintResult {
  return (
    isRecord(value) &&
    typeof value.generation === "number" &&
    Number.isSafeInteger(value.generation) &&
    typeof value.project_fingerprint === "string" &&
    typeof value.limited === "boolean" &&
    typeof value.truncated === "boolean" &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.length <= 1000 &&
    value.diagnostics.every(isDiagnostic) &&
    Array.isArray(value.files) &&
    value.files.every(
      (f: unknown) =>
        isRecord(f) && isFile(f.file) && typeof f.text_hash === "string",
    ) &&
    Array.isArray(value.engines) &&
    value.engines.every(
      (e: unknown) =>
        isRecord(e) &&
        typeof e.engine === "string" &&
        ["complete", "limited", "failed", "disabled"].includes(
          String(e.status),
        ) &&
        (e.message === null || typeof e.message === "string"),
    )
  );
}
function workingFile(
  tab: (EditorTab & { document?: SourceDocument }) | undefined,
  project?: Project,
): FileRef | undefined {
  const file = tab?.readonly ? undefined : tab?.document?.file;
  if (file && project) {
    const key = fileKey(file);
    const source = [
      ...project.sources.map((s) => s.path),
      ...(project.headers ?? []),
      ...(project.simulation_sources ?? []),
      ...(project.simulation_headers ?? []),
      ...Object.values(project.simulations).flatMap((c) => c.testbench),
    ].some((f) => fileKey(f) === key);
    const auxiliary = [
      ...project.assets,
      ...(project.imports ?? []).map((i) => i.location),
      ...Object.values(project.simulations).flatMap((c) => c.models),
    ].some((f) => fileKey(f) === key);
    if (auxiliary && !source) return undefined;
  }
  return file &&
    /\.(v|sv|vh|svh)$/i.test(typeof file === "string" ? file : file.path)
    ? file
    : undefined;
}
interface LintState {
  key: string;
  status: string;
  result?: EditorLintResult;
  error?: string;
}
interface Task {
  key: string;
  request: EditorLintRequest;
}

export function useEditorLint(
  workspace: WorkspaceProject | undefined,
  tabs: (EditorTab & { document?: SourceDocument })[],
  active: (EditorTab & { document?: SourceDocument }) | undefined,
  profile: Profile,
  simulation: string,
  paused: boolean,
) {
  const [savedPreferences, setSavedPreferences] = useState<{
    path: string;
    value: LintPreferences;
  }>();
  const path = workspace?.path ?? "";
  const settings =
    savedPreferences?.path === path
      ? savedPreferences.value
      : preferences(path);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<LintState>({ key: "", status: "Idle" });
  const owner = useRef<{
    busy: boolean;
    job?: string;
    pending?: Task;
    key: string;
    generation: number;
    alive: boolean;
  }>({ busy: false, key: "", generation: 0, alive: true });
  const activeFile = workingFile(active, workspace?.project);
  const contextKey = `${path}:${activeFile ? fileKey(activeFile) : ""}`;
  const context =
    workspace && activeFile
      ? lintContext(
          workspace.project,
          activeFile,
          simulation,
          overrides[contextKey],
        )
      : undefined;
  const buffers = tabs
    .filter((t) => workingFile(t, workspace?.project))
    .flatMap((t) =>
      t.document
        ? [
            {
              file: t.document.file,
              text: t.text,
              version: t.version ?? 0,
              revision: t.document.revision,
            },
          ]
        : [],
    );
  const signature = JSON.stringify({
    path,
    project: workspace?.project,
    activeFile,
    context: context?.context,
    buffers,
    profile,
    settings,
    paused,
    refresh,
  });
  // Responses are eligible only for the exact current buffers/context, including before effects run.
  const result = state.key === signature ? state.result : undefined;
  const pump = useCallback(async function run(): Promise<void> {
    const current = owner.current;
    if (current.busy || !current.pending || !current.alive) return;
    current.busy = true;
    const task = current.pending;
    current.pending = undefined;
    const eligible = () => current.alive && current.key === task.key;
    if (eligible()) setState({ key: task.key, status: "Checking…" });
    try {
      let job = await api<Job>("lint", task.request);
      current.job = job.id;
      if (!eligible()) await api("cancel", { id: job.id });
      while (job.status === "running") {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        job = await api<Job>("job", { id: job.id });
      }
      if (eligible()) {
        if (job.status === "complete") {
          const result = decodeLintResult(job.result);
          if (result.generation === task.request.generation)
            setState({
              key: task.key,
              status: lintStatus(result),
              result,
            });
        } else if (job.status === "failed")
          throw new Error(job.error ?? "Editor lint job failed");
      }
    } catch (error) {
      if (eligible())
        setState({
          key: task.key,
          status: "Unavailable",
          error: String(error),
        });
    } finally {
      current.job = undefined;
      current.busy = false;
      if (current.pending && current.alive) await run();
    }
  }, []);
  const input = useRef<EditorLintRequest | undefined>(undefined);
  useEffect(() => {
    const file = workingFile(active, workspace?.project);
    const selected =
      workspace && file
        ? lintContext(
            workspace.project,
            file,
            simulation,
            overrides[contextKey],
          )
        : undefined;
    input.current =
      workspace && file && selected && settings.enabled && !paused
        ? {
            path,
            active_file: file,
            context: selected.context,
            buffers: tabs.flatMap((tab) =>
              workingFile(tab, workspace.project) && tab.document
                ? [
                    {
                      file: tab.document.file,
                      text: tab.text,
                      version: tab.version ?? 0,
                    },
                  ]
                : [],
            ),
            profile,
            generation: 0,
            style: settings.style,
          }
        : undefined;
  }, [
    workspace,
    active,
    tabs,
    profile,
    simulation,
    overrides,
    contextKey,
    settings.enabled,
    settings.style,
    paused,
    path,
  ]);
  useEffect(() => {
    const current = owner.current;
    current.key = signature;
    current.pending = undefined;
    current.generation += 1;
    if (current.job)
      void api("cancel", { id: current.job }).catch(() => {
        /* The obsolete job may already have been released. */
      });
    if (!input.current) return;
    const task: Task = {
      key: signature,
      request: { ...input.current, generation: current.generation },
    };
    const timer = setTimeout(() => {
      current.pending = task;
      void pump().catch((error: unknown) => {
        if (current.alive && current.key === task.key)
          setState({
            key: task.key,
            status: "Unavailable",
            error: String(error),
          });
      });
    }, 750);
    return () => clearTimeout(timer);
  }, [signature, pump]);
  useEffect(() => {
    const current = owner.current;
    current.alive = true;
    const focus = () => setRefresh((v) => v + 1);
    window.addEventListener("focus", focus);
    return () => {
      current.alive = false;
      current.pending = undefined;
      if (current.job) void api("cancel", { id: current.job }).catch(() => {});
      window.removeEventListener("focus", focus);
    };
  }, []);
  const setSettings = (value: LintPreferences) => {
    localStorage.setItem(`hdlview-lint:${path}`, JSON.stringify(value));
    setSavedPreferences({ path, value });
  };
  return {
    settings,
    setSettings,
    result,
    status: !activeFile
      ? ""
      : !settings.enabled
        ? "Lint disabled"
        : paused
          ? "Lint paused"
          : state.key === signature
            ? state.status
            : "Check pending…",
    error: state.key === signature ? state.error : undefined,
    context,
    setContext: (name: string) =>
      setOverrides((previous) => ({ ...previous, [contextKey]: name })),
  };
}
