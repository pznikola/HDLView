import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api";
import {
  fileKey,
  fileLabel,
  pick,
  projects,
  sourceGroups,
  workspaceKey,
} from "./projects";
import type {
  FileRef,
  FileRole,
  ImportChoice,
  ImportRequest,
  Job,
  PreviewResult,
  SourceDocument,
  WorkspaceProject,
  SourceGroup,
  Technology,
  Project,
  FileDialog,
  FileChange,
  FileChangePreview,
  FileChangeResult,
  ExplorerLocation,
  CreateFileEntry,
  SettingsSection,
  Snapshot,
} from "./types";
import type { EditorTab } from "./components/SourceEditor";
import { SourceExplorer } from "./components/SourceExplorer";
import { FileManagementDialog } from "./components/FileManagementDialog";
import { ProjectSettings } from "./components/ProjectSettings";
import type { LintPreferences } from "./editor-lint";
interface WorkingTab extends EditorTab {
  document?: SourceDocument;
}
interface Decision {
  title: string;
  choices: string[];
  resolve: (choice: string) => void;
}
export function useProjectWorkspace(
  onActivate: () => void,
  onError: (error: unknown) => void,
  flushArtifacts: () => Promise<void>,
  externalBusy: boolean,
  revealEditor: () => void,
) {
  const [workspace, setWorkspace] = useState<WorkspaceProject>();
  const [savedProject, setSavedProject] = useState("");
  const [files, setFiles] = useState<FileRef[]>([]);
  const [locations, setLocations] = useState<ExplorerLocation[]>([]);
  const [fileDialog, setFileDialog] = useState<FileDialog>();
  const [fileJob, setFileJob] = useState<Job>();
  const [filePending, setFilePending] = useState(false);
  const fileEpoch = useRef(0);
  const [diskChanged, setDiskChanged] = useState(false);
  const fileBusy = filePending || fileJob?.status === "running";
  const [tabs, setTabs] = useState<WorkingTab[]>([]);
  const [active, setActive] = useState<string>();
  const [modal, setModal] = useState<
    "new" | "import" | "filelist" | "add" | undefined
  >();
  const [settingsSection, setSettingsSection] = useState<SettingsSection>();
  const [preview, setPreview] = useState<PreviewResult>();
  const [lastImport, setLastImport] = useState<ImportRequest>();
  const [job, setJob] = useState<Job>();
  const [decision, setDecision] = useState<Decision>();
  const [draft, setDraft] = useState<WorkspaceProject>();
  const [wizardStep, setWizardStep] = useState(0);
  const [draftWarnings, setDraftWarnings] = useState<string[]>([]);
  const [sourceGroup, setSourceGroup] = useState<SourceGroup>("design");
  const creating = !!draft;
  const importTarget = draft ?? workspace;
  const [stale, setStale] = useState(false);
  const generation = useRef(0);
  const changes = useRef(0);
  const buildChanges = useRef(0);
  const markChanged = useCallback(() => {
    changes.current += 1;
    setStale(true);
  }, []);
  const markBuildStarted = () => {
    buildChanges.current = changes.current;
  };
  const markStale = useCallback(() => setStale(true), []);
  const markBuilt = useCallback(
    () => setStale(changes.current !== buildChanges.current),
    [],
  );
  const pendingDecision = useRef<((choice: string) => void) | undefined>(
    undefined,
  );
  const ask = useCallback(
    (title: string, choices: string[]) =>
      new Promise<string>((resolve) => {
        pendingDecision.current?.("Cancel");
        pendingDecision.current = resolve;
        setDecision({
          title,
          choices,
          resolve: (choice) => {
            setDecision(undefined);
            pendingDecision.current = undefined;
            resolve(choice);
          },
        });
      }),
    [],
  );
  useEffect(() => () => pendingDecision.current?.("Cancel"), []);
  const updateTab = useCallback(
    (id: string, text: string) =>
      setTabs((previous) =>
        previous.map((t) =>
          t.id === id ? { ...t, text, version: (t.version ?? 0) + 1 } : t,
        ),
      ),
    [],
  );
  const applyWorkspace = useCallback(
    async (value: WorkspaceProject, saved = false) => {
      const requestGeneration = generation.current;
      const [files, locations] = await Promise.all([
        projects.files(value.path),
        projects.explorer(value.path),
      ]);
      if (requestGeneration !== generation.current) return;
      setWorkspace(value);
      if (saved) setSavedProject(JSON.stringify(value.project));
      setFiles(files);
      setLocations(locations);
    },
    [],
  );
  const saveTab = useCallback(
    async (tab: WorkingTab) => {
      if (!workspace || !tab.document || tab.readonly || tab.text === tab.saved)
        return true;
      const requestGeneration = generation.current;
      let result = await projects.write(workspace.path, tab.document, tab.text);
      if (requestGeneration !== generation.current) return false;
      if (result.status === "conflict") {
        const choice = await ask(`${tab.label} changed outside HDLView.`, [
          "Reload",
          "Overwrite",
          "Cancel",
        ]);
        if (requestGeneration !== generation.current) return false;
        if (choice === "Cancel") return false;
        if (choice === "Reload") {
          markChanged();
          setTabs((previous) =>
            previous.map((t) =>
              t.id === tab.id
                ? {
                    ...t,
                    document: result.document,
                    text: result.document.text,
                    saved: result.document.text,
                  }
                : t,
            ),
          );
          return false;
        }
        result = await projects.write(
          workspace.path,
          tab.document,
          tab.text,
          true,
        );
        if (requestGeneration !== generation.current) return false;
      }
      const document = result.document;
      setTabs((previous) =>
        previous.map((t) =>
          t.id === tab.id ? { ...t, document, saved: document.text } : t,
        ),
      );
      markChanged();
      return true;
    },
    [workspace, ask, markChanged],
  );
  const dirtyProject =
    !!workspace && JSON.stringify(workspace.project) !== savedProject;
  const dirty =
    tabs.some((t) => !t.readonly && t.text !== t.saved) || dirtyProject;
  const saveAll = useCallback(async () => {
    const requestGeneration = generation.current;
    for (const tab of tabs) {
      if (!(await saveTab(tab))) return false;
    }
    if (requestGeneration !== generation.current) return false;
    if (workspace) {
      const changed = JSON.stringify(workspace.project) !== savedProject;
      const value = await projects.save(workspace);
      if (requestGeneration !== generation.current) return false;
      await applyWorkspace(value, true);
      if (requestGeneration !== generation.current) return false;
      if (
        changed ||
        JSON.stringify(value.project) !== JSON.stringify(workspace.project)
      )
        markChanged();
    }
    await flushArtifacts();
    setDiskChanged(false);
    return true;
  }, [
    tabs,
    saveTab,
    workspace,
    savedProject,
    applyWorkspace,
    markChanged,
    flushArtifacts,
  ]);
  const guard = useCallback(async () => {
    if (externalBusy || job?.status === "running" || fileBusy) {
      onError(
        "Cancel the running project job before closing or switching projects.",
      );
      return false;
    }
    if (dirty) {
      const choice = await ask(
        diskChanged
          ? "Save changes before leaving? Discard does not undo files already created, renamed, or moved to Trash."
          : "Save changes before leaving this project?",
        ["Save", "Discard", "Cancel"],
      );
      if (choice === "Cancel" || (choice === "Save" && !(await saveAll())))
        return false;
    }
    await flushArtifacts();
    return true;
  }, [
    dirty,
    ask,
    saveAll,
    flushArtifacts,
    externalBusy,
    job?.status,
    fileBusy,
    diskChanged,
    onError,
  ]);
  const closeGuard = useRef(guard);
  useEffect(() => {
    closeGuard.current = guard;
  }, [guard]);
  const activate = useCallback(
    async (value: WorkspaceProject) => {
      const [nextFiles, nextLocations] = await Promise.all([
        projects.files(value.path),
        projects.explorer(value.path),
      ]);
      generation.current += 1;
      onActivate();
      setWorkspace(value);
      setSavedProject(JSON.stringify(value.project));
      setFiles(nextFiles);
      setLocations(nextLocations);
      setFileDialog(undefined);
      setFileJob(undefined);
      setDiskChanged(false);
      setSettingsSection(undefined);
      setTabs([]);
      setActive(undefined);
      setStale(false);
    },
    [onActivate],
  );
  const releaseCurrent = async () => {
    if (workspace) await projects.close(workspace.path);
  };
  const open = async () => {
    const selected = await pick("project");
    if (!selected?.[0]) return;
    // Validate before prompting or disturbing the visible workspace.
    const value = await projects.open(selected[0]);
    if (!(await guard())) return;
    if (workspace?.path !== value.path) await releaseCurrent();
    await activate(value);
  };
  const beginNew = async () => {
    if (draft) {
      await projects.close(workspaceKey(draft));
      setDraft(undefined);
    }
    setWizardStep(0);
    setDraftWarnings([]);
    setSourceGroup("design");
    setModal("new");
  };
  const beginDraft = async (
    directory: string,
    name: string,
    technology: Technology,
  ) => {
    const value = await projects.draft(
      `${directory.replace(/\/$/, "")}/hdlview.project.json`,
      name,
      technology,
    );
    if (draft) await projects.close(workspaceKey(draft));
    setDraft(value);
    setWizardStep(1);
  };
  const cancelDialog = async () => {
    if (draft && (modal === "new" || modal === "add")) {
      await projects.close(workspaceKey(draft));
      setDraft(undefined);
    }
    setPreview(undefined);
    setModal(
      draft && ["import", "filelist"].includes(modal ?? "") ? "new" : undefined,
    );
  };
  const create = async () => {
    if (!draft?.draft_id) return;
    if (!(await guard())) return;
    const revision = await projects.overwriteRevision(draft.draft_id);
    if (
      revision &&
      (await ask("A project configuration already exists here. Replace it?", [
        "Overwrite",
        "Cancel",
      ])) !== "Overwrite"
    )
      return;
    const value = await projects.publish(
      draft.draft_id,
      !!revision,
      revision ?? undefined,
    );
    if (workspace?.path !== value.path) await releaseCurrent();
    setDraft(undefined);
    setModal(undefined);
    await activate(value);
  };
  const close = async () => {
    if (!(await guard())) return;
    await releaseCurrent();
    generation.current += 1;
    onActivate();
    setWorkspace(undefined);
    setSavedProject("");
    setFiles([]);
    setLocations([]);
    setFileDialog(undefined);
    setDiskChanged(false);
    setSettingsSection(undefined);
    setTabs([]);
    setActive(undefined);
    setStale(false);
  };
  const updateTarget = async (project: Project) => {
    if (!importTarget) return;
    const value = await projects.update(workspaceKey(importTarget), project);
    if (draft) setDraft(value);
    else {
      await applyWorkspace(value);
      markChanged();
    }
  };
  const update = async (project: unknown) => {
    if (!workspace) return;
    const requestGeneration = generation.current;
    const value = await projects.update(workspace.path, project);
    if (requestGeneration !== generation.current) return;
    await applyWorkspace(value);
    if (requestGeneration !== generation.current) return;
    if (JSON.stringify(value.project) !== JSON.stringify(workspace.project))
      markChanged();
    return value;
  };
  const importFiles = async (request: ImportRequest) => {
    if (!importTarget) return;
    setLastImport(request);
    setJob(await projects.preview(workspaceKey(importTarget), request));
  };
  const chooseImport = async (
    kind: ImportRequest["kind"],
    record_index?: number,
    working_directory?: string,
    group: SourceGroup = sourceGroup,
  ) => {
    if (record_index !== undefined) {
      if (kind === "filelist") {
        setLastImport({
          kind,
          group,
          record_index,
          working_directory:
            working_directory ??
            workspace?.project.imports?.[record_index]?.working_directory ??
            undefined,
        });
        setModal("filelist");
        return;
      }
      await importFiles({ kind, group, record_index, working_directory });
      return;
    }
    const selected = await pick(
      kind === "folder"
        ? "directory"
        : kind === "filelist"
          ? "filelist"
          : "files",
      ["v", "sv", "vh", "svh"],
    );
    if (!selected?.length) return;
    if (kind === "filelist") {
      setLastImport({
        kind,
        group,
        paths: selected,
        working_directory:
          working_directory ??
          selected[0]?.slice(0, selected[0].lastIndexOf("/")),
      });
      setModal("filelist");
      return;
    }
    await importFiles({ kind, group, paths: selected, working_directory });
  };
  useEffect(() => {
    if (job?.status !== "running") return;
    let active = true;
    const timer = setInterval(() => {
      projects
        .job(job.id)
        .then((value) => {
          if (!active) return;
          setJob(value);
          if (value.status === "failed") onError(value.error);
          if (value.status === "complete") {
            setPreview(value.result as PreviewResult);
            setModal("import");
          }
        })
        .catch(onError);
    }, 200);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [job, onError]);
  const reparse = async (working_directory: string) => {
    if (lastImport) await importFiles({ ...lastImport, working_directory });
  };
  const applyImport = async (choices: ImportChoice[]) => {
    if (!preview) return;
    const value = await projects.apply(preview.token, choices);
    if (draft) {
      setDraft(value);
      setDraftWarnings((previous) => [
        ...previous,
        ...preview.preview.warnings,
      ]);
    } else {
      await applyWorkspace(value);
      markChanged();
    }
    setPreview(undefined);
    setModal(creating ? "new" : "add");
  };
  const openFile = async (
    file: FileRef,
    selection?: { from: number; to: number },
  ) => {
    if (!workspace) return;
    const id =
      tabs.find((t) => t.document && fileKey(t.document.file) === fileKey(file))
        ?.id ?? `working:${fileKey(file)}:${fileEpoch.current}`;
    const openedGeneration = generation.current;
    const openedFileEpoch = fileEpoch.current;
    if (!tabs.some((t) => t.id === id)) {
      const document = await projects.read(workspace.path, file);
      if (
        openedGeneration !== generation.current ||
        openedFileEpoch !== fileEpoch.current
      )
        return;
      setTabs((previous) =>
        previous.some((t) => t.id === id)
          ? previous
          : [
              ...previous,
              {
                id,
                label: fileLabel(file),
                text: document.text,
                saved: document.text,
                readonly: false,
                document,
              },
            ],
      );
    }
    if (selection)
      setTabs((previous) =>
        previous.map((tab) => (tab.id === id ? { ...tab, selection } : tab)),
      );
    setActive(id);
  };
  const openSnapshotSource = async (snapshotId: string, source: string) => {
    const openedGeneration = generation.current;
    const value = await api<{ text: string; file: string; line: string }>(
      "source",
      { snapshot_id: snapshotId, source },
    );
    if (openedGeneration !== generation.current) return;
    const id = `${snapshotId}:${value.file}`;
    setTabs((previous) => [
      ...previous.filter((t) => t.id !== id),
      {
        id,
        label: `Snapshot: ${value.file}`,
        text: value.text,
        saved: value.text,
        readonly: true,
        line: Number(value.line),
        snapshotId,
        source,
      },
    ]);
    setActive(id);
  };
  const openWorkingFile = async (tab: WorkingTab) => {
    if (!workspace || !tab.snapshotId || !tab.source) return;
    const file = await api<FileRef>("working_source", {
      snapshot_id: tab.snapshotId,
      source: tab.source,
      path: workspace.path,
    });
    await openFile(file);
  };
  const closeTab = async (tab: WorkingTab) => {
    if (!tab.readonly && tab.text !== tab.saved) {
      const choice = await ask(`Save changes to ${tab.label}?`, [
        "Save",
        "Discard",
        "Cancel",
      ]);
      if (choice === "Cancel" || (choice === "Save" && !(await saveTab(tab))))
        return;
    }
    const remaining = tabs.filter((t) => t.id !== tab.id);
    setTabs(remaining);
    if (active === tab.id) setActive(remaining.at(-1)?.id);
  };
  const beginFile = (
    folder = false,
    group: SourceGroup = sourceGroup,
    directory?: string,
  ) => {
    if (!workspace || externalBusy || job?.status === "running" || fileBusy)
      return;
    setFileDialog({
      kind: "create",
      request: {
        folder,
        group,
        directory:
          directory ??
          `${workspace.path.slice(0, workspace.path.lastIndexOf("/"))}/${group === "design" ? "rtl" : "sim"}`,
        name: folder ? "new-folder" : "untitled.sv",
      },
    });
  };
  const createEntry = async (request: CreateFileEntry) => {
    if (!workspace || fileBusy) return;
    setFilePending(true);
    try {
      const result = await projects.createEntry(workspace.path, request);
      fileEpoch.current += 1;
      await applyWorkspace(result.workspace);
      markChanged();
      setDiskChanged(true);
      setFileDialog(undefined);
      if (!request.folder && result.created) {
        await openFile(result.created, { from: 0, to: 0 });
        revealEditor();
      }
    } finally {
      setFilePending(false);
    }
  };
  const finishFileJob = async (initial: Job, previewEpoch?: number) => {
    let value = initial;
    setFileJob(value);
    while (value.status === "running") {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      value = await projects.job(value.id);
      setFileJob(value);
    }
    if (previewEpoch !== undefined && previewEpoch !== fileEpoch.current)
      return { ...value, status: "cancelled", result: null };
    if (value.status === "failed")
      throw new Error(value.error ?? "File operation failed");
    return value;
  };
  const previewChange = async (request: FileChange) => {
    if (!workspace || fileBusy) return;
    const epoch = fileEpoch.current;
    const result = await finishFileJob(
      await projects.previewChange(workspace.path, {
        ...request,
        open_files: tabs.flatMap((tab) =>
          tab.document ? [tab.document.file] : [],
        ),
      }),
      epoch,
    );
    if (result.status === "complete")
      setFileDialog({
        kind: "review",
        result: result.result as FileChangePreview,
      });
  };
  const cancelFileOperation = async () => {
    fileEpoch.current += 1;
    if (fileJob?.status === "running") await api("cancel", { id: fileJob.id });
  };
  const beginChange = (request: FileChange) => {
    if (request.kind === "rename") setFileDialog({ kind: "rename", request });
    else return previewChange(request);
  };
  const applyChange = async (result: FileChangePreview) => {
    if (!workspace || fileBusy) return;
    const removing = result.preview.request.kind !== "rename";
    const keys = new Set(result.preview.affected.map((c) => fileKey(c.from)));
    let savedWorking = false;
    if (removing) {
      for (const tab of tabs.filter(
        (t) =>
          t.document &&
          keys.has(fileKey(t.document.file)) &&
          t.text !== t.saved,
      )) {
        const choice = await ask(
          `Save changes to ${tab.label} before removing it?`,
          ["Save", "Discard", "Cancel"],
        );
        if (choice === "Cancel" || (choice === "Save" && !(await saveTab(tab))))
          return;
        if (choice === "Save") savedWorking = true;
      }
    }
    // Saving a dirty document changes the disk revision, so obtain a fresh review before committing.
    let fresh = result;
    if (savedWorking) {
      const epoch = fileEpoch.current;
      const reviewed = await finishFileJob(
        await projects.previewChange(workspace.path, result.preview.request),
        epoch,
      );
      if (reviewed.status !== "complete") return;
      fresh = reviewed.result as FileChangePreview;
      if (fresh.preview.disk_revision !== result.preview.disk_revision) {
        setFileDialog({ kind: "review", result: fresh });
        return;
      }
    }
    const terminal = await finishFileJob(
      await projects.applyChange(workspace.path, fresh.token),
    );
    if (terminal.status !== "complete") return;
    const changed = terminal.result as FileChangeResult;
    fileEpoch.current += 1;
    await applyWorkspace(changed.workspace);
    const updates = new Map(
      changed.affected.map((c) => [fileKey(c.from), c.to]),
    );
    setTabs((previous) =>
      previous.flatMap((tab) => {
        if (!tab.document) return [tab];
        const key = fileKey(tab.document.file);
        if (!updates.has(key)) return [tab];
        const file = updates.get(key);
        if (!file) return [];
        return [
          {
            ...tab,
            label: fileLabel(file),
            document: { ...tab.document, file },
          },
        ];
      }),
    );
    if (
      tabs.some(
        (t) =>
          t.id === active &&
          t.document &&
          updates.get(fileKey(t.document.file)) === null,
      )
    )
      setActive(
        tabs.find((t) => !t.document || !updates.has(fileKey(t.document.file)))
          ?.id,
      );
    markChanged();
    if (!removing || result.preview.request.kind === "trash")
      setDiskChanged(true);
    setFileDialog(undefined);
  };
  const beforeBuild = async () => {
    if (!dirty) return true;
    return (
      (await ask("Save all changes before building?", [
        "Save All and Build",
        "Cancel",
      ])) === "Save All and Build" && (await saveAll())
    );
  };
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s")
        return;
      event.preventDefault();
      if (modal || settingsSection || fileDialog || fileBusy) return;
      const tab = tabs.find((t) => t.id === active);
      (event.shiftKey ? saveAll() : tab ? saveTab(tab) : saveAll()).catch(
        onError,
      );
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [
    active,
    tabs,
    saveTab,
    saveAll,
    onError,
    modal,
    settingsSection,
    fileDialog,
    fileBusy,
  ]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "n" &&
        workspace &&
        !modal &&
        !settingsSection &&
        !fileDialog &&
        !fileBusy &&
        !externalBusy
      ) {
        event.preventDefault();
        beginFile();
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  });
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onCloseRequested((event) => {
        event.preventDefault();
        closeGuard
          .current()
          .then((leave) => {
            if (leave) return getCurrentWindow().destroy();
          })
          .catch(onError);
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(onError);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [onError]);
  return {
    workspace,
    files,
    locations,
    fileDialog,
    setFileDialog,
    fileJob,
    fileBusy,
    cancelFileOperation,
    beginFile,
    createEntry,
    beginChange,
    previewChange,
    applyChange,
    tabs,
    active,
    setActive,
    activeTab: tabs.find((t) => t.id === active),
    modal,
    setModal,
    settingsSection,
    setSettingsSection,
    preview,
    lastImport,
    job,
    decision,
    creating,
    draft,
    wizardStep,
    setWizardStep,
    draftWarnings,
    sourceGroup,
    setSourceGroup,
    importTarget,
    beginDraft,
    cancelDialog,
    updateTarget,
    close,
    markStale,
    dirtyProject,
    stale,
    markBuildStarted,
    markBuilt,
    open,
    beginNew,
    create,
    update,
    chooseImport,
    importFiles,
    reparse,
    applyImport,
    openFile,
    openSnapshotSource,
    openWorkingFile,
    updateTab,
    saveTab,
    saveAll,
    closeTab,
    beforeBuild,
  };
}
export type ProjectController = ReturnType<typeof useProjectWorkspace>;
function FilelistOptions({
  controller: c,
  onError,
}: {
  controller: ProjectController;
  onError: (error: unknown) => void;
}) {
  const [working, setWorking] = useState(c.lastImport?.working_directory ?? "");
  return (
    <>
      <p>
        Resolve nested -f contents against this directory. -F contents use their
        own list directory.
      </p>
      <label>
        Import working directory
        <input
          aria-label="Import working directory"
          value={working}
          onChange={(e) => setWorking(e.target.value)}
        />
      </label>
      <button
        onClick={() =>
          void pick("directory")
            .then((paths) => {
              if (paths?.[0]) setWorking(paths[0]);
            })
            .catch(onError)
        }
      >
        Choose Working Directory
      </button>
      <button
        className="primary"
        onClick={() => {
          if (c.lastImport)
            void c
              .importFiles({
                ...c.lastImport,
                working_directory: working || undefined,
              })
              .then(() => c.setModal(undefined))
              .catch(onError);
        }}
      >
        Preview Filelist
      </button>
    </>
  );
}
export function ProjectToolbar({
  controller: c,
  busy,
  onError,
}: {
  controller: ProjectController;
  busy: boolean;
  onError: (error: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = [
    { label: "Create New Project…", disabled: busy, action: c.beginNew },
    { label: "Open Existing Project…", disabled: busy, action: c.open },
    null,
    {
      label: "New File…",
      disabled: busy || !c.workspace,
      action: () => c.beginFile(),
    },
    {
      label: "Add New Files…",
      disabled: busy || !c.workspace,
      action: () => c.setModal("add"),
    },
    null,
    {
      label: "Save Project",
      disabled: busy || !c.workspace,
      action: c.saveAll,
    },
    { label: "Close Project", disabled: busy || !c.workspace, action: c.close },
  ];
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !root.current?.contains(event.target)
      ) {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    root.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus();
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.altKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setOpen((previous) => !previous);
        trigger.current?.focus();
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, []);
  const dismiss = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <div className="project-controls">
      <div
        className="file-menu"
        ref={root}
        onBlur={(event) => {
          if (
            event.relatedTarget instanceof Node &&
            !root.current?.contains(event.relatedTarget)
          )
            setOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            dismiss();
          }
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
            return;
          event.preventDefault();
          if (!open) {
            setOpen(true);
            return;
          }
          const buttons = Array.from(
            root.current?.querySelectorAll<HTMLButtonElement>(
              '[role="menuitem"]:not(:disabled)',
            ) ?? [],
          );
          const current = buttons.findIndex(
            (button) => button === document.activeElement,
          );
          const index =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : (current +
                    (event.key === "ArrowUp" ? -1 : 1) +
                    buttons.length) %
                  buttons.length;
          buttons[index]?.focus();
        }}
      >
        <button
          ref={trigger}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          File
        </button>
        {open && (
          <div className="command-menu" role="menu" aria-label="File">
            {items.map((item, index) =>
              item ? (
                <button
                  role="menuitem"
                  key={item.label}
                  disabled={item.disabled}
                  onClick={() => {
                    dismiss();
                    Promise.resolve(item.action()).catch(onError);
                  }}
                >
                  {item.label}
                </button>
              ) : (
                <hr role="separator" key={index} />
              ),
            )}
          </div>
        )}
      </div>
      <button
        disabled={busy || !c.workspace}
        onClick={() => c.setSettingsSection("general")}
      >
        Project Settings
      </button>
    </div>
  );
}
export function ProjectSources(props: {
  controller: ProjectController;
  busy: boolean;
  onOpen: (file: FileRef) => void;
  onError: (error: unknown) => void;
}) {
  return (
    <SourceExplorer
      key={props.controller.workspace?.path ?? "closed"}
      {...props}
    />
  );
}
function SourceSelection({
  controller: c,
  onError,
}: {
  controller: ProjectController;
  onError: (error: unknown) => void;
}) {
  return (
    <>
      <label>
        Source group
        <select
          aria-label="Source group"
          value={c.sourceGroup}
          onChange={(event) => {
            const group = sourceGroups.find((g) => g.id === event.target.value);
            if (group) c.setSourceGroup(group.id);
          }}
        >
          {sourceGroups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.label}
            </option>
          ))}
        </select>
      </label>
      <p>
        Sources remain in their original locations. Simulation sources can be
        reused across RTL and gate snapshots.
      </p>
      <div className="source-actions">
        {(
          [
            ["files", "Select Files"],
            ["folder", "Add Folder"],
            ["filelist", "Import Filelist"],
          ] as const
        ).map(([kind, label]) => (
          <button
            key={kind}
            disabled={c.job?.status === "running"}
            onClick={() => void c.chooseImport(kind).catch(onError)}
          >
            {label}
          </button>
        ))}
      </div>
      {c.modal === "add" && (
        <button onClick={() => c.setModal(undefined)}>Done</button>
      )}
    </>
  );
}
function ProjectReview({
  controller: c,
  onError,
}: {
  controller: ProjectController;
  onError: (error: unknown) => void;
}) {
  const project = c.draft?.project;
  if (!project) return null;
  const lists = [
    {
      label: "Design Sources",
      entries: project.sources.map((s) => s.path),
      key: "sources" as const,
    },
    {
      label: "Simulation Sources",
      entries: project.simulation_sources ?? [],
      key: "simulation_sources" as const,
    },
  ];
  return (
    <>
      <p>
        {project.name} · Verilog / SystemVerilog ·{" "}
        {project.technology === "sky130" ? "SKY130" : "IHP SG13G2"}
      </p>
      {c.draftWarnings.map((warning, index) => (
        <p className="hint" key={index}>
          {warning}
        </p>
      ))}
      {lists.map((list) => (
        <section key={list.key}>
          <h4>{list.label}</h4>
          {list.entries.map((file, index) => {
            const change = (delta?: number) => {
              const entries = [...(project[list.key] ?? [])];
              if (delta === undefined) entries.splice(index, 1);
              else {
                const target = index + delta;
                const current = entries[index];
                const other = entries[target];
                if (current && other) {
                  entries[index] = other;
                  entries[target] = current;
                }
              }
              void c
                .updateTarget({ ...project, [list.key]: entries })
                .catch(onError);
            };
            return (
              <div className="order-row" key={fileKey(file)}>
                <span>{fileLabel(file)}</span>
                <button
                  aria-label={`Move ${fileLabel(file)} up`}
                  disabled={index === 0}
                  onClick={() => change(-1)}
                >
                  ↑
                </button>
                <button
                  aria-label={`Move ${fileLabel(file)} down`}
                  disabled={index === list.entries.length - 1}
                  onClick={() => change(1)}
                >
                  ↓
                </button>
                <button
                  aria-label={`Exclude ${fileLabel(file)}`}
                  onClick={() => change()}
                >
                  Exclude
                </button>
              </div>
            );
          })}
        </section>
      ))}
      <details>
        <summary>Headers and import settings</summary>
        <pre>
          {JSON.stringify(
            {
              headers: project.headers,
              simulation_headers: project.simulation_headers,
              include_dirs: project.include_dirs,
              defines: project.defines,
            },
            null,
            2,
          )}
        </pre>
      </details>
      <p>
        Set the top module and clock settings in Project Settings before
        building.
      </p>
    </>
  );
}
function NewProjectForm({
  controller: c,
  onError,
}: {
  controller: ProjectController;
  onError: (error: unknown) => void;
}) {
  const [name, setName] = useState(c.draft?.project.name ?? "");
  const [directory, setDirectory] = useState(
    c.draft?.path.slice(0, c.draft.path.lastIndexOf("/")) ?? "",
  );
  const [technology, setTechnology] = useState<Technology | "">(
    c.draft?.project.technology ?? "",
  );
  return (
    <>
      <p className="wizard-steps">
        {["Project", "Sources", "Review"].map((label, index) => (
          <span
            key={label}
            aria-current={c.wizardStep === index ? "step" : undefined}
          >
            {index + 1}. {label}
          </span>
        ))}
      </p>
      {c.wizardStep === 0 ? (
        <>
          <label>
            Project name
            <input
              aria-label="Project name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            Project directory
            <div className="directory-choice">
              <input
                aria-label="Project directory"
                readOnly
                value={directory}
              />
              <button
                onClick={() =>
                  void pick("directory")
                    .then((paths) => {
                      if (paths?.[0]) setDirectory(paths[0]);
                    })
                    .catch(onError)
                }
              >
                Choose Directory
              </button>
            </div>
          </label>
          <p>Language: Verilog / SystemVerilog</p>
          <label>
            Technology
            <select
              aria-label="Technology"
              value={technology}
              onChange={(event) =>
                setTechnology(
                  event.target.value === "sky130"
                    ? "sky130"
                    : event.target.value === "ihp_sg13g2"
                      ? "ihp_sg13g2"
                      : "",
                )
              }
            >
              <option value="">Select technology</option>
              <option value="sky130">SKY130</option>
              <option value="ihp_sg13g2">IHP SG13G2</option>
            </select>
          </label>
          <button
            className="primary"
            disabled={!name.trim() || !directory || !technology}
            onClick={() => {
              if (technology)
                void c.beginDraft(directory, name, technology).catch(onError);
            }}
          >
            Next: Sources
          </button>
        </>
      ) : c.wizardStep === 1 ? (
        <>
          <p className="hint">
            Sources are optional. Create an empty project and add or create
            files afterward.
          </p>
          <SourceSelection controller={c} onError={onError} />
          <p>
            {c.draft?.project.sources.length ?? 0} design files ·{" "}
            {c.draft?.project.simulation_sources?.length ?? 0} simulation files
          </p>
          <button onClick={() => c.setWizardStep(2)}>Next: Review</button>
        </>
      ) : (
        <>
          <ProjectReview controller={c} onError={onError} />
          <button onClick={() => c.setWizardStep(1)}>Back: Sources</button>
          <button
            className="primary"
            onClick={() => void c.create().catch(onError)}
          >
            Create New Project
          </button>
        </>
      )}
    </>
  );
}
function ImportForm({
  controller: c,
  onError,
}: {
  controller: ProjectController;
  onError: (error: unknown) => void;
}) {
  const preview = c.preview?.preview;
  const [choices, setChoices] = useState<ImportChoice[]>(
    preview?.entries.map((entry, index) => ({
      index,
      role: entry.role,
      selected: !entry.excluded,
    })) ?? [],
  );
  const [working, setWorking] = useState(
    preview?.record?.working_directory ?? "",
  );
  if (!preview) return null;
  return (
    <>
      <p>
        Review files before applying. Files remain at their original locations.
      </p>
      {preview.record?.kind === "filelist" &&
        preview.replace_record !== null &&
        preview.replace_record !== undefined && (
          <p>Reimported sources use this filelist order.</p>
        )}
      {preview.warnings.map((warning, index) => (
        <p className="hint" key={index}>
          {warning}
        </p>
      ))}
      {preview.record?.kind === "filelist" && (
        <label>
          Filelist working directory
          <input
            aria-label="Filelist working directory"
            value={working}
            onChange={(e) => setWorking(e.target.value)}
          />
          <button onClick={() => void c.reparse(working).catch(onError)}>
            Reparse Filelist
          </button>
        </label>
      )}
      <div className="import-entries">
        {preview.entries.map((entry, index) => {
          const choice = choices[index];
          if (!choice) return null;
          return (
            <div key={index}>
              <input
                type="checkbox"
                aria-label={`Include ${fileLabel(entry.file)}`}
                checked={choice.selected}
                onChange={(e) =>
                  setChoices((previous) =>
                    previous.map((c, i) =>
                      i === index ? { ...c, selected: e.target.checked } : c,
                    ),
                  )
                }
              />
              <span>
                {fileLabel(entry.file)}
                {entry.excluded ? " (excluded)" : ""}
                {entry.missing
                  ? " (missing from import)"
                  : (c.draft ? [] : c.files).some(
                        (f) => fileKey(f) === fileKey(entry.file),
                      )
                    ? " (already in project)"
                    : " (new)"}
              </span>
              <select
                aria-label={`Role for ${fileLabel(entry.file)}`}
                value={choice.role}
                onChange={(e) =>
                  setChoices((previous) =>
                    previous.map((c, i) =>
                      i === index
                        ? { ...c, role: e.target.value as FileRole }
                        : c,
                    ),
                  )
                }
              >
                {entry.missing ? (
                  <option value="remove">Remove from project</option>
                ) : (
                  <>
                    <option value="design">Design source</option>
                    <option value="header">Design header</option>
                    <option value="simulation">Simulation source</option>
                    <option value="simulation_header">Simulation header</option>
                  </>
                )}
              </select>
            </div>
          );
        })}
      </div>
      <details>
        <summary>Imported include directories and defines</summary>
        <pre>
          {JSON.stringify(
            {
              include_dirs: preview.project.include_dirs,
              defines: preview.project.defines,
            },
            null,
            2,
          )}
        </pre>
      </details>
      <button
        className="primary"
        onClick={() => void c.applyImport(choices).catch(onError)}
      >
        Apply Import
      </button>
    </>
  );
}
export function ProjectDialogs({
  controller: c,
  onError,
  lintPreferences,
  onLintPreferences,
  snapshot,
}: {
  controller: ProjectController;
  onError: (error: unknown) => void;
  lintPreferences: LintPreferences;
  onLintPreferences: (preferences: LintPreferences) => void;
  snapshot?: Snapshot;
}) {
  return (
    <>
      {c.settingsSection && (
        <ProjectSettings
          key={c.workspace?.path}
          controller={c}
          lintPreferences={lintPreferences}
          onLintPreferences={onLintPreferences}
          snapshot={snapshot}
          onError={onError}
        />
      )}
      {c.fileDialog && (
        <FileManagementDialog
          key={c.fileDialog.kind}
          controller={c}
          onError={onError}
        />
      )}
      {c.fileJob?.status === "running" && (
        <div className="import-progress">
          Working on project files…{" "}
          <button onClick={() => void c.cancelFileOperation().catch(onError)}>
            Cancel
          </button>
        </div>
      )}
      {c.modal && (
        <div className="modal-backdrop">
          <section
            className="modal project-modal"
            role="dialog"
            aria-label={
              c.modal === "new"
                ? "Create New Project"
                : c.modal === "add"
                  ? "Add New Files"
                  : c.modal === "filelist"
                    ? "Filelist Import"
                    : "Import Review"
            }
          >
            <div className="modal-title">
              <strong>
                {c.modal === "new"
                  ? "Create New Project"
                  : c.modal === "add"
                    ? "Add New Files"
                    : c.modal === "filelist"
                      ? "Filelist Import"
                      : "Import Review"}
              </strong>
              <button
                aria-label="Close project dialog"
                disabled={c.job?.status === "running"}
                onClick={() => void c.cancelDialog().catch(onError)}
              >
                ×
              </button>
            </div>
            {c.modal === "new" ? (
              <NewProjectForm controller={c} onError={onError} />
            ) : c.modal === "add" ? (
              <SourceSelection controller={c} onError={onError} />
            ) : c.modal === "filelist" ? (
              <FilelistOptions controller={c} onError={onError} />
            ) : (
              <ImportForm
                key={c.preview?.token}
                controller={c}
                onError={onError}
              />
            )}
          </section>
        </div>
      )}
      {c.decision && (
        <div className="modal-backdrop decision-backdrop">
          <section className="modal" role="dialog" aria-label="Unsaved changes">
            <h3>{c.decision.title}</h3>
            {c.decision.choices.map((choice) => (
              <button key={choice} onClick={() => c.decision?.resolve(choice)}>
                {choice}
              </button>
            ))}
          </section>
        </div>
      )}
      {c.job?.status === "running" && (
        <div className="import-progress">
          Scanning project files…{" "}
          <button
            onClick={() => void api("cancel", { id: c.job?.id }).catch(onError)}
          >
            Cancel
          </button>
        </div>
      )}
    </>
  );
}
