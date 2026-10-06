import { fileKey, fileLabel, sourceGroups } from "./projects";
import type { FileRef, Project, SourceGroup } from "./types";
export interface SourceNode {
  id: string;
  label: string;
  group: SourceGroup | "aux";
  kind: "group" | "folder" | "file";
  file: FileRef;
  children: SourceNode[];
}
export function sourceTree(project: Project, files: FileRef[]): SourceNode[] {
  const groups: SourceNode[] = [
    ...sourceGroups,
    { id: "aux" as const, label: "Filelists and Auxiliary Files" },
  ].map((g) => ({
    id: g.id,
    label: g.label,
    group: g.id,
    kind: "group",
    file: ".",
    children: [],
  }));
  const contains = (list: FileRef[] | undefined, file: FileRef) =>
    list?.some((f) => fileKey(f) === fileKey(file));
  const groupOf = (file: FileRef) => {
    if (
      project.sources.some((s) => fileKey(s.path) === fileKey(file)) ||
      contains(project.headers, file)
    )
      return "design";
    if (
      contains(project.simulation_sources, file) ||
      contains(project.simulation_headers, file) ||
      Object.values(project.simulations).some((s) =>
        contains(s.testbench, file),
      )
    )
      return "simulation";
    return "aux";
  };
  const insert = (
    file: FileRef,
    group: SourceNode["group"],
    folder: boolean,
  ) => {
    let parent = groups.find((g) => g.group === group);
    if (!parent) return;
    const parts = (typeof file === "string" ? file : file.path)
      .split("/")
      .filter((p) => p && p !== ".");
    const ensure = (label: string, ref: FileRef, kind: SourceNode["kind"]) => {
      if (!parent) return;
      const id = `${group}:${kind}:${fileKey(ref)}`;
      let node = parent.children.find((n) => n.id === id);
      if (!node) {
        node = { id, label, file: ref, kind, group, children: [] };
        parent.children.push(node);
      }
      parent = node;
    };
    if (typeof file !== "string")
      ensure(`@${file.root}`, { root: file.root, path: "." }, "folder");
    parts.forEach((part, i) => {
      const last = i === parts.length - 1;
      const ref: FileRef = last
        ? file
        : typeof file === "string"
          ? (file.startsWith("/") ? "/" : "") + parts.slice(0, i + 1).join("/")
          : { root: file.root, path: parts.slice(0, i + 1).join("/") };
      ensure(part, ref, last && !folder ? "file" : "folder");
    });
  };
  for (const file of files) insert(file, groupOf(file), false);
  for (const record of project.imports ?? [])
    if (record.kind === "folder")
      insert(record.location, record.group ?? "design", true);
  const sort = (node: SourceNode) => {
    node.children.sort(
      (a, b) =>
        Number(a.kind === "file") - Number(b.kind === "file") ||
        a.label.localeCompare(b.label, "en"),
    );
    node.children.forEach(sort);
  };
  groups.forEach(sort);
  return groups;
}
export function flattenSources(
  nodes: SourceNode[],
  collapsed: Set<string>,
  level = 1,
): { node: SourceNode; level: number; parent?: string }[] {
  return nodes.flatMap((node) => [
    { node, level },
    ...(!collapsed.has(node.id)
      ? flattenSources(node.children, collapsed, level + 1).map((entry) => ({
          ...entry,
          parent: entry.parent ?? node.id,
        }))
      : []),
  ]);
}
export function fileKind(file: FileRef, project: Project) {
  if (/\.(svh|vh)$/i.test(fileLabel(file))) return "header";
  if (project.sources.some((s) => fileKey(s.path) === fileKey(file)))
    return "RTL";
  if (
    project.simulation_sources?.some((f) => fileKey(f) === fileKey(file)) ||
    Object.values(project.simulations).some((s) =>
      s.testbench.some((f) => fileKey(f) === fileKey(file)),
    )
  )
    return "sim";
  return /\.(f|flist)$/i.test(fileLabel(file)) ? "list" : "aux";
}
