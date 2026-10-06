import { describe, expect, it } from "vitest";
import { flattenSources, sourceTree } from "./source-explorer";
import type { Project } from "./types";
const project: Project = {
  schema_version: 3,
  name: "explorer",
  top: "",
  standard: "1800-2017",
  include_dirs: [],
  defines: {},
  parameters: {},
  assets: [],
  simulations: {},
  sources: [
    { path: "rtl/a.sv", language: "system_verilog" },
    { path: { root: "outside", path: "rtl/a.sv" }, language: "system_verilog" },
  ],
  simulation_sources: ["sim/a.sv"],
  headers: ["rtl/a.svh"],
  imports: [
    { kind: "folder", group: "design", location: "rtl/empty", files: [] },
  ],
  source_roots: { outside: "../outside" },
};
describe("registered source tree", () => {
  it("preserves groups, empty directories, roots and duplicate basenames", () => {
    const tree = sourceTree(project, [
      "rtl/a.sv",
      { root: "outside", path: "rtl/a.sv" },
      "sim/a.sv",
      "rtl/a.svh",
    ]);
    const entries = flattenSources(tree, new Set());
    expect(
      entries.filter((e) => e.node.label === "a.sv").map((e) => e.node.group),
    ).toEqual(["design", "design", "simulation"]);
    expect(
      entries.some((e) => e.node.kind === "folder" && e.node.label === "empty"),
    ).toBe(true);
    expect(entries.find((e) => e.node.label === "@outside")?.node.file).toEqual(
      { root: "outside", path: "." },
    );
    expect(new Set(entries.map((e) => e.node.id)).size).toBe(entries.length);
  });
  it("keeps empty projects actionable and hides collapsed descendants", () => {
    const empty = sourceTree(
      {
        ...project,
        sources: [],
        headers: [],
        simulation_sources: [],
        imports: [],
      },
      [],
    );
    expect(flattenSources(empty, new Set()).map((e) => e.node.kind)).toEqual([
      "group",
      "group",
      "group",
    ]);
    const tree = sourceTree(project, ["rtl/a.sv", "sim/a.sv"]);
    const collapsed = flattenSources(tree, new Set(["design"]));
    expect(collapsed.filter((e) => e.node.group === "design")).toHaveLength(1);
    const simulation = collapsed.find((e) => e.node.label === "a.sv");
    expect(simulation?.level).toBe(3);
    expect(simulation?.parent).toContain("folder");
  });
});
