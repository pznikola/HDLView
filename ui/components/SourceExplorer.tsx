import { useEffect, useMemo, useRef, useState } from "react";
import { fileKey, fileLabel } from "../projects";
import {
  fileKind,
  flattenSources,
  sourceTree,
  type SourceNode,
} from "../source-explorer";
import type { ProjectController } from "../project-workspace";
import type { FileRef, SourceGroup } from "../types";
function Icon({
  kind,
}: {
  kind: "file" | "folder" | "header" | "new-file" | "new-folder";
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className="source-icon"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      {kind === "folder" || kind === "new-folder" ? (
        <path d="M2 5h6l2 2h8v10H2z" />
      ) : (
        <path d="M4 2h8l4 4v12H4z M12 2v5h4" />
      )}
      {kind === "header" && <path d="M7 10h6M7 13h6" />}
      {(kind === "new-file" || kind === "new-folder") && (
        <path d="M12 12h8m-4-4v8" strokeWidth="2" />
      )}
    </svg>
  );
}
export function SourceExplorer({
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
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [selected, setSelected] = useState("design");
  const [context, setContext] = useState<{
    node: SourceNode;
    x: number;
    y: number;
  }>();
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const project = c.workspace?.project;
  const tree = useMemo(
    () => (project ? sourceTree(project, c.files) : []),
    [project, c.files],
  );
  const activeKey = c.activeTab?.document
    ? fileKey(c.activeTab.document.file)
    : undefined;
  useEffect(() => {
    if (!activeKey) return;
    const all = flattenSources(tree, new Set<string>());
    const active = all.find(
      (entry) =>
        entry.node.kind === "file" && fileKey(entry.node.file) === activeKey,
    );
    if (!active) return;
    const ancestors = new Set<string>();
    let parent = active.parent;
    while (parent) {
      ancestors.add(parent);
      parent = all.find((entry) => entry.node.id === parent)?.parent;
    }
    setSelected(active.node.id);
    setCollapsed(
      (previous) => new Set([...previous].filter((id) => !ancestors.has(id))),
    );
  }, [activeKey, tree]);
  const visible = flattenSources(tree, collapsed);
  const findLocation = (node: SourceNode) =>
    c.locations.find((e) => fileKey(e.file) === fileKey(node.file));
  const focusNode = (id: string) => {
    setSelected(id);
    const node = visible.find((entry) => entry.node.id === id)?.node;
    if (node && node.group !== "aux") c.setSourceGroup(node.group);
    root.current
      ?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`)
      ?.focus();
  };
  const expand = (node: SourceNode, close?: boolean) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (close ?? !next.has(node.id)) next.add(node.id);
      else next.delete(node.id);
      return next;
    });
  const dismiss = () => {
    setContext(undefined);
    trigger.current?.focus();
  };
  useEffect(() => {
    if (!context) return;
    menu.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
    const close = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !menu.current?.contains(event.target)
      ) {
        setContext(undefined);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [context]);
  if (!project)
    return <p className="hint">Use File to open or create a project.</p>;
  const menuItems = (
    node: SourceNode,
  ): { label: string; disabled?: boolean; action: () => unknown }[] => {
    const info = findLocation(node);
    const sourceGroup: SourceGroup =
      node.group === "simulation" ? "simulation" : "design";
    const directory = node.kind === "group" ? undefined : info?.location;
    const items: {
      label: string;
      disabled?: boolean;
      action: () => unknown;
    }[] = [];
    if (node.kind !== "file" && node.group !== "aux")
      items.push(
        {
          label: "New File…",
          action: () => c.beginFile(false, sourceGroup, directory),
        },
        {
          label: "New Folder…",
          action: () => c.beginFile(true, sourceGroup, directory),
        },
        {
          label: "Add Existing Files…",
          action: () => {
            c.setSourceGroup(sourceGroup);
            c.setModal("add");
          },
        },
      );
    if (node.kind !== "group")
      items.push(
        {
          label: "Rename…",
          disabled: !info?.mutable || !info.exists,
          action: () =>
            c.beginChange({
              file: node.file,
              directory: node.kind === "folder",
              kind: "rename",
            }),
        },
        {
          label: "Remove from Project…",
          action: () =>
            c.beginChange({
              file: node.file,
              directory: node.kind === "folder",
              kind: "remove",
            }),
        },
        {
          label: "Move to Trash…",
          disabled: !info?.mutable || !info.exists,
          action: () =>
            c.beginChange({
              file: node.file,
              directory: node.kind === "folder",
              kind: "trash",
            }),
        },
      );
    (project.imports ?? []).forEach((record, index) => {
      if (
        fileKey(record.location) === fileKey(node.file) &&
        (node.group === "aux" || (record.group ?? "design") === node.group)
      )
        items.push({
          label:
            (record.kind === "folder" ? "Rescan Folder" : "Reimport Filelist") +
            ((project.imports ?? []).filter(
              (r) =>
                fileKey(r.location) === fileKey(record.location) &&
                r.group === record.group,
            ).length > 1
              ? ` (${record.working_directory ?? "list directory"})`
              : ""),
          action: () =>
            c.chooseImport(record.kind, index, undefined, record.group),
        });
    });
    return items;
  };
  const showMenu = (
    node: SourceNode,
    target: HTMLElement,
    x: number,
    y: number,
  ) => {
    trigger.current = target;
    setSelected(node.id);
    if (node.group !== "aux") c.setSourceGroup(node.group);
    setContext({
      node,
      x: Math.min(x, window.innerWidth - 240),
      y: Math.max(8, Math.min(y, window.innerHeight - 300)),
    });
  };
  return (
    <>
      <div className="panel-heading">PROJECT SOURCES</div>
      <div
        className="source-tree"
        role="tree"
        aria-label="Project sources"
        ref={root}
      >
        {visible.map(({ node, level, parent }, index) => {
          const info = findLocation(node);
          const dirty = c.tabs.some(
            (t) =>
              t.document &&
              fileKey(t.document.file) === fileKey(node.file) &&
              t.text !== t.saved,
          );
          const active =
            c.activeTab?.document &&
            fileKey(c.activeTab.document.file) === fileKey(node.file);
          const folder = node.kind !== "file";
          return (
            <div
              className={`source-row ${node.kind === "group" ? "source-group" : ""} ${selected === node.id ? "selected" : ""} ${active ? "active-file" : ""}`}
              key={node.id}
              data-source-group={node.group}
            >
              <button
                role="treeitem"
                className={folder ? "source-folder" : "source-file"}
                aria-level={level}
                aria-selected={selected === node.id}
                aria-expanded={folder ? !collapsed.has(node.id) : undefined}
                aria-label={node.label}
                tabIndex={
                  selected === node.id ||
                  (!visible.some((r) => r.node.id === selected) && index === 0)
                    ? 0
                    : -1
                }
                data-node-id={node.id}
                data-source-path={fileLabel(node.file)}
                title={fileLabel(node.file)}
                style={{
                  paddingLeft: `${8 + (folder ? level - 1 : 0) * 14}px`,
                }}
                onClick={() => {
                  setSelected(node.id);
                  if (node.group !== "aux") c.setSourceGroup(node.group);
                  if (folder) expand(node);
                  else onOpen(node.file);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  showMenu(
                    node,
                    event.currentTarget,
                    event.clientX,
                    event.clientY,
                  );
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    focusNode(
                      visible[
                        Math.max(
                          0,
                          Math.min(
                            visible.length - 1,
                            index + (event.key === "ArrowDown" ? 1 : -1),
                          ),
                        )
                      ]?.node.id ?? node.id,
                    );
                  } else if (event.key === "Home" || event.key === "End") {
                    event.preventDefault();
                    focusNode(
                      visible[event.key === "Home" ? 0 : visible.length - 1]
                        ?.node.id ?? node.id,
                    );
                  } else if (event.key === "ArrowRight" && folder) {
                    event.preventDefault();
                    if (collapsed.has(node.id)) expand(node, false);
                    else if (node.children[0]) focusNode(node.children[0].id);
                  } else if (event.key === "ArrowLeft") {
                    event.preventDefault();
                    if (folder && !collapsed.has(node.id)) expand(node, true);
                    else if (parent) focusNode(parent);
                  } else if (
                    event.key === "F2" &&
                    !busy &&
                    node.kind !== "group" &&
                    info?.mutable &&
                    info.exists
                  ) {
                    event.preventDefault();
                    void Promise.resolve(
                      c.beginChange({
                        file: node.file,
                        directory: folder,
                        kind: "rename",
                      }),
                    ).catch(onError);
                  } else if (event.key === "F10" && event.shiftKey) {
                    event.preventDefault();
                    const rect = event.currentTarget.getBoundingClientRect();
                    showMenu(node, event.currentTarget, rect.left, rect.bottom);
                  }
                }}
              >
                <span className="source-arrow" aria-hidden="true">
                  {folder ? (collapsed.has(node.id) ? "▸" : "▾") : ""}
                </span>
                {node.kind !== "group" && (
                  <Icon
                    kind={
                      folder
                        ? "folder"
                        : /\.(svh|vh)$/i.test(node.label)
                          ? "header"
                          : "file"
                    }
                  />
                )}
                <span className="source-name">{node.label}</span>
                {!folder && (
                  <small className="source-kind">
                    {fileKind(node.file, project)}
                  </small>
                )}
                {dirty && (
                  <span aria-label="Unsaved changes" className="source-dirty">
                    ●
                  </span>
                )}
                {info && !info.exists && (
                  <small className="source-missing">missing</small>
                )}
              </button>
              {node.kind === "group" && node.group !== "aux" && (
                <span className="source-heading-actions">
                  <button
                    aria-label={`New file in ${node.label}`}
                    title="New File"
                    disabled={busy}
                    onClick={() => {
                      setCollapsed((previous) => {
                        const next = new Set(previous);
                        next.delete(node.id);
                        return next;
                      });
                      c.beginFile(false, node.group as SourceGroup);
                    }}
                  >
                    <Icon kind="new-file" />
                  </button>
                  <button
                    aria-label={`New folder in ${node.label}`}
                    title="New Folder"
                    disabled={busy}
                    onClick={() => c.beginFile(true, node.group as SourceGroup)}
                  >
                    <Icon kind="new-folder" />
                  </button>
                </span>
              )}
            </div>
          );
        })}
        {!c.files.length && (
          <p className="hint">
            Create a file with the heading icons or File → New File. Add
            existing files through File → Add New Files.
          </p>
        )}
      </div>
      {context && (
        <div
          className="command-menu source-context"
          role="menu"
          aria-label="Source actions"
          ref={menu}
          style={{ left: context.x, top: context.y }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              dismiss();
            }
            if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              const buttons = Array.from(
                menu.current?.querySelectorAll<HTMLButtonElement>(
                  "button:not(:disabled)",
                ) ?? [],
              );
              const current = buttons.findIndex(
                (b) => b === document.activeElement,
              );
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? buttons.length - 1
                    : (current +
                        (event.key === "ArrowUp" ? -1 : 1) +
                        buttons.length) %
                      buttons.length;
              buttons[next]?.focus();
            }
          }}
        >
          {menuItems(context.node).map((item) => (
            <button
              role="menuitem"
              key={item.label}
              disabled={busy || item.disabled}
              onClick={() => {
                dismiss();
                void Promise.resolve(item.action()).catch(onError);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
