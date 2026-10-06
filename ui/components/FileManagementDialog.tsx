import { useEffect, useRef, useState } from "react";
import { fileLabel, pick } from "../projects";
import type { ProjectController } from "../project-workspace";
import type { SourceGroup } from "../types";
export function FileManagementDialog({
  controller: c,
  onError,
}: {
  controller: ProjectController;
  onError: (error: unknown) => void;
}) {
  const dialog = c.fileDialog;
  const input = useRef<HTMLInputElement>(null);
  const section = useRef<HTMLElement>(null);
  const previousFocus = useRef(document.activeElement);
  const [error, setError] = useState("");
  const [name, setName] = useState(
    dialog?.kind === "create"
      ? dialog.request.name
      : dialog?.kind === "rename"
        ? (fileLabel(dialog.request.file).split("/").at(-1) ?? "")
        : "",
  );
  const [directory, setDirectory] = useState(
    dialog?.kind === "create" ? dialog.request.directory : "",
  );
  const [group, setGroup] = useState<SourceGroup>(
    dialog?.kind === "create" ? dialog.request.group : "design",
  );
  useEffect(() => {
    const element = input.current;
    if (element) {
      element.focus();
      const dot = element.value.lastIndexOf(".");
      element.setSelectionRange(0, dot > 0 ? dot : element.value.length);
    } else section.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const before = previousFocus.current;
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);
  if (!dialog) return null;
  const folder = dialog.kind === "create" && dialog.request.folder;
  const title =
    dialog.kind === "create"
      ? folder
        ? "New Folder"
        : "New File"
      : dialog.kind === "rename"
        ? "Rename"
        : dialog.result.preview.request.kind === "rename"
          ? "Review Rename"
          : dialog.result.preview.request.kind === "trash"
            ? "Move to Trash"
            : "Remove from Project";
  const submit = async () => {
    setError("");
    try {
      if (dialog.kind === "create")
        await c.createEntry({ ...dialog.request, name, directory, group });
      else if (dialog.kind === "rename")
        await c.previewChange({ ...dialog.request, name });
      else await c.applyChange(dialog.result);
    } catch (error) {
      setError(String(error));
      onError(error);
    }
  };
  return (
    <div className="modal-backdrop">
      <section
        ref={section}
        className="modal file-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !c.fileBusy) {
            event.preventDefault();
            c.setFileDialog(undefined);
          }
          if (event.key === "Tab") {
            const controls = Array.from(
              section.current?.querySelectorAll<HTMLElement>(
                "button:not(:disabled),input:not(:disabled),select:not(:disabled)",
              ) ?? [],
            );
            const first = controls[0];
            const last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <div className="modal-title">
          <strong>{title}</strong>
          <button
            aria-label="Close file dialog"
            disabled={c.fileBusy}
            onClick={() => c.setFileDialog(undefined)}
          >
            ×
          </button>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {dialog.kind === "create" && (
            <>
              <label>
                Source group
                <select
                  aria-label="New entry source group"
                  value={group}
                  disabled={c.fileBusy}
                  onChange={(event) => {
                    const next: SourceGroup =
                      event.target.value === "simulation"
                        ? "simulation"
                        : "design";
                    const base = c.workspace?.path.slice(
                      0,
                      c.workspace.path.lastIndexOf("/"),
                    );
                    if (
                      base &&
                      directory ===
                        `${base}/${group === "design" ? "rtl" : "sim"}`
                    )
                      setDirectory(
                        `${base}/${next === "design" ? "rtl" : "sim"}`,
                      );
                    setGroup(next);
                  }}
                >
                  <option value="design">Design Sources</option>
                  <option value="simulation">Simulation Sources</option>
                </select>
              </label>
              <label>
                Destination directory
                <div className="directory-choice">
                  <input
                    aria-label="Destination directory"
                    value={directory}
                    readOnly
                  />
                  <button
                    type="button"
                    disabled={c.fileBusy}
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
            </>
          )}
          {dialog.kind !== "review" ? (
            <>
              <label>
                {folder ? "Folder name" : "File name"}
                <input
                  ref={input}
                  aria-label={folder ? "Folder name" : "File name"}
                  value={name}
                  disabled={c.fileBusy}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              {dialog.kind === "rename" && (
                <p>
                  Rename {fileLabel(dialog.request.file)}. Include strings and
                  filelist contents require manual updates.
                </p>
              )}
              {!folder && dialog.kind === "create" && (
                <p className="hint">
                  Use .sv, .v, .svh, or .vh. The new file will be empty.
                </p>
              )}
            </>
          ) : (
            <>
              <p className="file-operation-path">
                {dialog.result.preview.location}
              </p>
              <p>
                {dialog.result.preview.request.kind === "rename"
                  ? `New name: ${dialog.result.preview.request.name ?? ""}`
                  : dialog.result.preview.request.kind === "remove"
                    ? "Original files remain on disk."
                    : "Original files will move to your desktop Trash."}
              </p>
              <div className="file-change-entries">
                {dialog.result.preview.affected.map((change) => (
                  <div key={fileLabel(change.from)}>
                    {fileLabel(change.from)}
                    {change.to ? ` → ${fileLabel(change.to)}` : ""}
                  </div>
                ))}
              </div>
              {!!dialog.result.preview.simulations.length && (
                <p>
                  Affected simulation configurations:{" "}
                  {dialog.result.preview.simulations.join(", ")}. Removed inputs
                  may require updating their settings.
                </p>
              )}
              {dialog.result.preview.warnings.map((warning) => (
                <p className="hint" key={warning}>
                  {warning}
                </p>
              ))}
              {dialog.result.preview.blocked.map((reason) => (
                <p role="alert" key={reason}>
                  {reason}
                </p>
              ))}
            </>
          )}
          <p className="hint">
            Save Project persists membership. Discard does not undo completed
            disk operations.
          </p>
          {error && <p role="alert">{error}</p>}
          <div className="file-dialog-actions">
            <button
              type="button"
              disabled={c.fileBusy}
              onClick={() => c.setFileDialog(undefined)}
            >
              Cancel
            </button>
            <button
              className="primary"
              type="submit"
              disabled={
                c.fileBusy ||
                (!name.trim() && dialog.kind !== "review") ||
                (dialog.kind === "review" &&
                  !!dialog.result.preview.blocked.length)
              }
            >
              {c.fileBusy
                ? "Working…"
                : dialog.kind === "review"
                  ? title === "Review Rename"
                    ? "Rename"
                    : title
                  : dialog.kind === "rename"
                    ? "Review Rename"
                    : title === "New Folder"
                      ? "Create Folder"
                      : "Create File"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
