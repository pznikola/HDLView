import { open } from "@tauri-apps/plugin-dialog";
import { api } from "./api";
import type {
  FileRef,
  ImportChoice,
  ImportRequest,
  Job,
  PreviewResult,
  SaveResult,
  SourceDocument,
  WorkspaceProject,
  Technology,
  SourceGroup,
  RestoredProject,
  Snapshot,
  SimulationConfig,
  CreateFileEntry,
  FileChange,
  FileChangeResult,
  ExplorerLocation,
  Project,
  SettingsValidation,
  SettingsInputKind,
  SettingsReferences,
} from "./types";
export type Picker =
  | "project"
  | "directory"
  | "files"
  | "filelist"
  | "settings";
declare global {
  interface Window {
    __HDLVIEW_TEST_PICKER__?: (kind: Picker) => Promise<string[] | null>;
  }
}
export async function pick(
  kind: Picker,
  extensions?: string[],
): Promise<string[] | null> {
  if (
    (import.meta.env.DEV || import.meta.env.MODE === "e2e") &&
    window.__HDLVIEW_TEST_PICKER__
  )
    return window.__HDLVIEW_TEST_PICKER__(kind);
  const result = await open({
    title: {
      project: "Open HDLView project",
      directory: "Select folder",
      files: "Add RTL files",
      filelist: "Import RTL filelist",
      settings: "Select settings input",
    }[kind],
    directory: kind === "directory",
    multiple: kind === "files",
    filters:
      kind === "directory"
        ? undefined
        : [
            {
              name:
                kind === "project"
                  ? "Project configuration"
                  : kind === "filelist"
                    ? "RTL filelist"
                    : kind === "settings"
                      ? "Settings inputs"
                      : "RTL sources",
              extensions:
                kind === "project"
                  ? ["json"]
                  : kind === "filelist"
                    ? ["f", "flist"]
                    : (extensions ?? ["v", "sv", "vh", "svh"]),
            },
          ],
  });
  return result === null
    ? null
    : typeof result === "string"
      ? [result]
      : result;
}
export const projects = {
  open: (path: string) => api<WorkspaceProject>("open_project", { path }),
  draft: (path: string, name: string, technology: Technology) =>
    api<WorkspaceProject>("create_project_draft", {
      path,
      name,
      technology,
    }),
  publish: (draft_id: string, overwrite: boolean, expected_revision?: string) =>
    api<WorkspaceProject>("publish_project_draft", {
      draft_id,
      overwrite,
      expected_revision,
    }),
  overwriteRevision: (draft_id: string) =>
    api<string | null>("project_overwrite_revision", { draft_id }),
  close: (path: string) => api("close_project", { path }),
  restore: (path: string) =>
    api<RestoredProject>("restore_project_state", { path }),
  checkpoint: (path: string, snapshot_path: string, run_path?: string) =>
    api("save_project_state", { path, snapshot_path, run_path }),
  update: (path: string, project: unknown) =>
    api<WorkspaceProject>("update_project", { path, project }),
  validateSettings: (path: string, project: Project, snapshot_id?: string) =>
    api<SettingsValidation>("validate_project_settings", {
      path,
      project,
      snapshot_id,
    }),
  settingsReferences: (
    path: string,
    project: Project,
    kind: SettingsInputKind,
    paths: string[],
  ) =>
    api<SettingsReferences>("resolve_settings_inputs", {
      path,
      request: { project, kind, paths },
    }),
  save: (workspace: WorkspaceProject) =>
    api<WorkspaceProject>("save_project", {
      path: workspace.path,
      project: workspace.project,
      expected_revision: workspace.revision,
    }),
  preview: (path: string, request: ImportRequest) =>
    api<Job>("preview_import", { path, request }),
  apply: (token: string, choices: ImportChoice[]) =>
    api<WorkspaceProject>("apply_import", { token, choices }),
  files: (path: string) => api<FileRef[]>("project_files", { path }),
  explorer: (path: string) =>
    api<ExplorerLocation[]>("project_explorer", { path }),
  createEntry: (path: string, request: CreateFileEntry) =>
    api<FileChangeResult>("create_file_entry", { path, request }),
  previewChange: (path: string, request: FileChange) =>
    api<Job>("preview_file_change", { path, request }),
  applyChange: (path: string, token: string) =>
    api<Job>("apply_file_change", { path, token }),
  read: (path: string, file: FileRef) =>
    api<SourceDocument>("read_document", { path, file }),
  write: (
    path: string,
    document: SourceDocument,
    text: string,
    overwrite = false,
  ) =>
    api<SaveResult>("save_document", {
      path,
      document: {
        file: document.file,
        text,
        expected_revision: document.revision,
        overwrite,
      },
    }),
  job: (id: string) => api<Job>("job", { id }),
};
export function fileLabel(file: FileRef): string {
  return typeof file === "string"
    ? file.startsWith("@")
      ? `./${file}`
      : file
    : `@${file.root}/${file.path}`;
}
export function fileKey(file: FileRef): string {
  return JSON.stringify(
    typeof file === "string" ? file : [file.root, file.path],
  );
}
export type { PreviewResult };

export const sourceGroups: { id: SourceGroup; label: string }[] = [
  { id: "design", label: "Design Sources" },
  { id: "simulation", label: "Simulation Sources" },
];
export function workspaceKey(workspace: WorkspaceProject): string {
  return workspace.draft_id ?? workspace.path;
}

export function canSimulate(
  config: SimulationConfig,
  snapshot?: Pick<Snapshot, "representation" | "sdf">,
): boolean {
  const gate =
    !!snapshot && ["mapped", "post_layout"].includes(snapshot.representation);
  // Gate netlists run under Icarus only: Verilator mis-models cell flip-flops.
  if (gate && config.simulator !== "icarus") return false;
  if (!config.sdf && !config.use_snapshot_sdf) return true;
  if (!gate) return false;
  if (!config.use_snapshot_sdf) return true;
  return config.timing_corner
    ? Boolean(snapshot.sdf[config.timing_corner])
    : Object.keys(snapshot.sdf).length === 1;
}
