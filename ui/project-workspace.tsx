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
} from "./types";
import type { EditorTab } from "./components/SourceEditor";
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
) {
  const [workspace, setWorkspace] = useState<WorkspaceProject>();
  const [savedProject, setSavedProject] = useState("");
  const [files, setFiles] = useState<FileRef[]>([]);
  const [tabs, setTabs] = useState<WorkingTab[]>([]);
  const [active, setActive] = useState<string>();
  const [modal, setModal] = useState<
    "new" | "settings" | "import" | "filelist" | "add" | undefined
  >();
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
        previous.map((t) => (t.id === id ? { ...t, text } : t)),
      ),
    [],
  );
  const applyWorkspace = useCallback(
    async (value: WorkspaceProject, saved = false) => {
      const requestGeneration = generation.current;
      const files = await projects.files(value.path);
      if (requestGeneration !== generation.current) return;
      setWorkspace(value);
      if (saved) setSavedProject(JSON.stringify(value.project));
      setFiles(files);
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
      const changed =
        workspace.project.schema_version < 3 ||
        JSON.stringify(workspace.project) !== savedProject;
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
    if (externalBusy || job?.status === "running") {
      onError(
        "Cancel the running project job before closing or switching projects.",
      );
      return false;
    }
    if (dirty) {
      const choice = await ask("Save changes before leaving this project?", [
        "Save",
        "Discard",
        "Cancel",
      ]);
      if (choice === "Cancel" || (choice === "Save" && !(await saveAll())))
        return false;
    }
    await flushArtifacts();
    return true;
  }, [dirty, ask, saveAll, flushArtifacts, externalBusy, job?.status, onError]);
  const closeGuard = useRef(guard);
  useEffect(() => {
    closeGuard.current = guard;
  }, [guard]);
  const activate = useCallback(
    async (value: WorkspaceProject) => {
      const nextFiles = await projects.files(value.path);
      generation.current += 1;
      onActivate();
      setWorkspace(value);
      setSavedProject(JSON.stringify(value.project));
      setFiles(nextFiles);
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
    markChanged();
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
  const openFile = async (file: FileRef) => {
    if (!workspace) return;
    const id = fileKey(file);
    const openedGeneration = generation.current;
    if (!tabs.some((t) => t.id === id)) {
      const document = await projects.read(workspace.path, file);
      if (openedGeneration !== generation.current) return;
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
      if (modal) return;
      const tab = tabs.find((t) => t.id === active);
      (event.shiftKey ? saveAll() : tab ? saveTab(tab) : saveAll()).catch(
        onError,
      );
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [active, tabs, saveTab, saveAll, onError, modal]);
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
    tabs,
    active,
    setActive,
    activeTab: tabs.find((t) => t.id === active),
    modal,
    setModal,
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
        onClick={() => c.setModal("settings")}
      >
        Project Settings
      </button>
    </div>
  );
}
function SourceTree({
  files,
  project,
  onOpen,
  directories = [],
}: {
  directories?: string[];
  files: FileRef[];
  project: WorkspaceProject["project"];
  onOpen: (file: FileRef) => void;
}) {
  interface Tree {
    dirs: Map<string, Tree>;
    files: FileRef[];
  }
  const tree: Tree = { dirs: new Map(), files: [] };
  const role = (file: FileRef) => {
    const key = fileKey(file);
    if (
      [...(project.headers ?? []), ...(project.simulation_headers ?? [])].some(
        (f) => fileKey(f) === key,
      )
    )
      return "header";
    if (project.sources.some((s) => fileKey(s.path) === key)) return "RTL";
    if (project.simulation_sources?.some((f) => fileKey(f) === key))
      return "sim";
    if (
      Object.values(project.simulations).some((s) =>
        s.testbench.some((f) => fileKey(f) === key),
      )
    )
      return "sim";
    return /\.(f|flist)$/i.test(fileLabel(file)) ? "list" : "aux";
  };
  const directoryNode = (parts: string[]) => {
    let node = tree;
    for (const part of parts) {
      let child = node.dirs.get(part);
      if (!child) {
        child = { dirs: new Map(), files: [] };
        node.dirs.set(part, child);
      }
      node = child;
    }
    return node;
  };
  for (const directory of directories) {
    if (directory !== ".") directoryNode(directory.split("/"));
  }
  for (const file of files) {
    directoryNode(fileLabel(file).split("/").slice(0, -1)).files.push(file);
  }
  const render = (node: Tree, prefix: string): React.ReactNode => (
    <>
      {[...node.dirs].map(([name, child]) => (
        <details key={`${prefix}/${name}`} open>
          <summary
            tabIndex={0}
            data-source-path={`${prefix}/${name}`.replace(/^\//, "")}
          >
            {name}
          </summary>
          {render(child, `${prefix}/${name}`)}
        </details>
      ))}
      {node.files.map((file) => (
        <button
          className="source-file"
          data-source-path={fileLabel(file)}
          key={fileKey(file)}
          title={fileLabel(file)}
          onClick={() => onOpen(file)}
        >
          {fileLabel(file).split("/").at(-1)}
          <small className="source-kind">{role(file)}</small>
        </button>
      ))}
    </>
  );
  return <div className="source-tree">{render(tree, "")}</div>;
}
export function ProjectSources({
  controller: c,
  busy,
  onOpen,
  onError,
}: {
  controller: ProjectController;
  busy: boolean;
  onOpen: (file: FileRef) => void;
  onError: (error: unknown) => void;
}) {
  const [context, setContext] = useState<{
    indices: number[];
    x: number;
    y: number;
  }>();
  const menu = useRef<HTMLDivElement>(null);
  const contextTrigger = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!context) return;
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target))
        setContext(undefined);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [context]);
  const project = c.workspace?.project;
  const byRole = (file: FileRef) => {
    const contains = (files: FileRef[] | undefined) =>
      files?.some((f) => fileKey(f) === fileKey(file));
    if (
      project?.sources.some((s) => fileKey(s.path) === fileKey(file)) ||
      contains(project?.headers)
    )
      return "design";
    if (
      contains(project?.simulation_sources) ||
      contains(project?.simulation_headers) ||
      Object.values(project?.simulations ?? {}).some((s) =>
        s.testbench.some((f) => fileKey(f) === fileKey(file)),
      )
    )
      return "simulation";
    return "aux";
  };
  const showContext = (target: HTMLElement, x: number, y: number) => {
    const path =
      target.closest<HTMLElement>("[data-source-path]")?.dataset.sourcePath;
    const group = target.closest<HTMLElement>("[data-source-group]")?.dataset
      .sourceGroup;
    const indices = (project?.imports ?? []).flatMap((r, index) =>
      fileLabel(r.location).replace(/\/\.$/, "") === path &&
      (group === "aux" || r.group === group)
        ? [index]
        : [],
    );
    if (indices.length) setContext({ indices, x, y });
  };
  return (
    <>
      <div className="panel-heading">PROJECT SOURCES</div>
      {project ? (
        <div
          onContextMenu={(event) => {
            if (event.target instanceof HTMLElement) {
              event.preventDefault();
              showContext(event.target, event.clientX, event.clientY);
            }
          }}
          onKeyDown={(event) => {
            if (
              event.shiftKey &&
              event.key === "F10" &&
              event.target instanceof HTMLElement
            ) {
              event.preventDefault();
              const rect = event.target.getBoundingClientRect();
              showContext(event.target, rect.left, rect.bottom);
            }
          }}
        >
          {[
            ...sourceGroups,
            { id: "aux", label: "Filelists and Auxiliary Files" },
          ].map((group) => (
            <details
              open
              key={group.id}
              className="source-group"
              data-source-group={group.id}
            >
              <summary
                tabIndex={0}
                data-source-path="."
                data-source-group={group.id}
              >
                {group.label}
              </summary>
              <SourceTree
                files={c.files.filter((f) => byRole(f) === group.id)}
                directories={project.imports
                  ?.filter(
                    (r) =>
                      r.kind === "folder" && (r.group ?? "design") === group.id,
                  )
                  .map((r) => fileLabel(r.location).replace(/\/\.$/, ""))}
                project={project}
                onOpen={onOpen}
              />
            </details>
          ))}
          {!c.files.length && (
            <p className="hint">Use File → Add New Files to add sources.</p>
          )}
        </div>
      ) : (
        <p className="hint">Use File to open or create a project.</p>
      )}
      {context && (
        <div
          className="command-menu source-context"
          style={{ left: context.x, top: context.y }}
          ref={menu}
          role="menu"
          aria-label="Source actions"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setContext(undefined);
              contextTrigger.current?.focus();
            }
          }}
        >
          {context.indices.map((index) => {
            const record = project?.imports?.[index];
            if (!record) return null;
            const label =
              record.kind === "folder" ? "Rescan Folder" : "Reimport Filelist";
            return (
              <button
                key={index}
                role="menuitem"
                disabled={busy}
                onClick={() => {
                  void c
                    .chooseImport(record.kind, index, undefined, record.group)
                    .catch(onError);
                  setContext(undefined);
                }}
              >
                {label}
                {context.indices.length > 1
                  ? ` (${record.working_directory ?? "list directory"})`
                  : ""}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
function SettingsForm({
  controller: c,
  onError,
}: {
  controller: ProjectController;
  onError: (error: unknown) => void;
}) {
  const [project, setProject] = useState(c.workspace?.project);
  const [includes, setIncludes] = useState(
    c.workspace?.project.include_dirs.map(fileLabel).join("\n") ?? "",
  );
  const [defines, setDefines] = useState(
    Object.entries(c.workspace?.project.defines ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  const [clockPort, setClockPort] = useState(
    c.workspace?.project.physical?.clock_port ?? "",
  );
  const [clockPeriod, setClockPeriod] = useState(
    c.workspace?.project.physical?.clock_period_ns?.toString() ?? "",
  );
  const [advanced, setAdvanced] = useState(
    JSON.stringify(c.workspace?.project, null, 2),
  );
  if (!project) return null;
  const reorder = (index: number, delta: number) => {
    const sources = [...project.sources];
    const current = sources[index];
    const target = sources[index + delta];
    if (!current || !target) return;
    sources[index] = target;
    sources[index + delta] = current;
    setProject({ ...project, sources });
  };
  const reference = (label: string): FileRef => {
    const [prefix, ...rest] = label.split("/");
    const root = prefix?.startsWith("@") ? prefix.slice(1) : undefined;
    return root && project.source_roots?.[root] !== undefined
      ? { root, path: rest.join("/") || "." }
      : label;
  };
  const apply = async () => {
    const values: Record<string, string> = {};
    for (const line of defines.split("\n").filter((l) => l.trim())) {
      const at = line.indexOf("=");
      const key = (at < 0 ? line : line.slice(0, at)).trim();
      if (key in values) throw new Error(`Duplicate define ${key}`);
      values[key] = at < 0 ? "1" : line.slice(at + 1);
    }
    let physical = project.physical;
    if (clockPort || clockPeriod) {
      const period = Number(clockPeriod);
      if (
        !project.technology ||
        !clockPort ||
        !Number.isFinite(period) ||
        period <= 0
      )
        throw new Error(
          "Choose a technology, clock port, and positive clock period",
        );
      const preset =
        project.technology === "sky130"
          ? { pdk: "sky130A", library: "sky130_fd_sc_hd" }
          : { pdk: "ihp-sg13g2", library: "sg13g2_stdcell" };
      physical = {
        ...physical,
        ...preset,
        clock_port: clockPort,
        clock_period_ns: period,
        overrides: physical?.overrides ?? {},
      };
    } else physical = undefined;
    await c.update({
      ...project,
      physical,
      include_dirs: includes
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map(reference),
      defines: values,
    });
    c.setModal(undefined);
  };
  return (
    <>
      <label>
        Top module
        <input
          aria-label="Top module"
          value={project.top}
          onChange={(e) => setProject({ ...project, top: e.target.value })}
        />
      </label>
      <label>
        Language standard
        <input
          aria-label="Language standard"
          value={project.standard}
          onChange={(e) => setProject({ ...project, standard: e.target.value })}
        />
      </label>
      <label>
        Technology
        <select
          aria-label="Technology"
          value={project.technology ?? ""}
          onChange={(event) => {
            const technology =
              event.target.value === "sky130"
                ? "sky130"
                : event.target.value === "ihp_sg13g2"
                  ? "ihp_sg13g2"
                  : null;
            setProject({ ...project, technology });
          }}
        >
          <option value="">Not selected</option>
          <option value="sky130">SKY130</option>
          <option value="ihp_sg13g2">IHP SG13G2</option>
        </select>
      </label>
      <details>
        <summary>Mapped and physical build settings</summary>
        <label>
          Clock port
          <input
            aria-label="Clock port"
            value={clockPort}
            onChange={(event) => setClockPort(event.target.value)}
          />
        </label>
        <label>
          Clock period (ns)
          <input
            aria-label="Clock period (ns)"
            value={clockPeriod}
            onChange={(event) => setClockPeriod(event.target.value)}
          />
        </label>
      </details>
      <h3>Compilation order</h3>
      <div className="compile-order">
        {project.sources.map((source, index) => (
          <div key={`${fileKey(source.path)}:${index}`}>
            <span>{fileLabel(source.path)}</span>
            <button
              aria-label={`Move ${fileLabel(source.path)} up`}
              disabled={index === 0}
              onClick={() => reorder(index, -1)}
            >
              ↑
            </button>
            <button
              aria-label={`Move ${fileLabel(source.path)} down`}
              disabled={index === project.sources.length - 1}
              onClick={() => reorder(index, 1)}
            >
              ↓
            </button>
            <button
              aria-label={`Remove ${fileLabel(source.path)} from project`}
              onClick={() =>
                setProject({
                  ...project,
                  sources: project.sources.filter((_, i) => i !== index),
                })
              }
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <label>
        Include directories (project-relative or @root/path, one per line)
        <textarea
          aria-label="Include directories"
          value={includes}
          onChange={(e) => setIncludes(e.target.value)}
        />
      </label>
      <label>
        Defines (NAME=value, one per line)
        <textarea
          aria-label="Defines"
          value={defines}
          onChange={(e) => setDefines(e.target.value)}
        />
      </label>
      <button className="primary" onClick={() => void apply().catch(onError)}>
        Apply Settings
      </button>
      <details>
        <summary>Advanced JSON: simulation and physical flow</summary>
        <textarea
          aria-label="Advanced project JSON"
          rows={18}
          value={advanced}
          onChange={(e) => setAdvanced(e.target.value)}
        />
        <button
          onClick={() => {
            let value: unknown;
            try {
              value = JSON.parse(advanced);
            } catch (e) {
              onError(e);
              return;
            }
            void c
              .update(value)
              .then(() => c.setModal(undefined))
              .catch(onError);
          }}
        >
          Apply Advanced JSON
        </button>
      </details>
    </>
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
      selected: true,
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
}: {
  controller: ProjectController;
  onError: (error: unknown) => void;
}) {
  return (
    <>
      {c.modal && (
        <div className="modal-backdrop">
          <section
            className="modal project-modal"
            role="dialog"
            aria-label={
              c.modal === "new"
                ? "Create New Project"
                : c.modal === "settings"
                  ? "Project Settings"
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
                  : c.modal === "settings"
                    ? "Project Settings"
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
            ) : c.modal === "settings" ? (
              <SettingsForm controller={c} onError={onError} />
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
