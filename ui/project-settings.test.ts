import { describe, expect, it } from "vitest";
import {
  newSimulation,
  rebaseSettings,
  settingsDraft,
  settingsProject,
  uniqueSimulationName,
} from "./project-settings";
import type { Project, SimulationConfig } from "./types";
const simulation: SimulationConfig = {
  simulator: "icarus",
  top: "tb",
  dut_scope: ["tb", "dut"],
  testbench: [{ root: "external", path: "tb.sv" }],
  args: ["+message=with spaces"],
  stop_time: "1us",
  models: [],
  defines: { MODE: "2" },
  use_snapshot_sdf: true,
  sdf: null,
  timing_corner: "corner",
  delay_selection: "max",
};
const project: Project = {
  schema_version: 3,
  name: "test",
  top: "top",
  standard: "1800-2017",
  technology: "sky130",
  sources: [{ path: "top.sv", language: "system_verilog" }],
  headers: ["defs.svh"],
  simulation_sources: simulation.testbench,
  source_roots: { external: "../rtl" },
  imports: [],
  assets: ["data.hex"],
  include_dirs: ["include"],
  defines: { WIDTH: "4" },
  parameters: { WIDTH: "4" },
  simulations: { shared: simulation },
  physical: {
    pdk: "sky130A",
    library: "sky130_fd_sc_hd",
    clock_port: "clk",
    clock_period_ns: 10,
    sdc: "timing.sdc",
    overrides: {
      FP_CORE_UTIL: 25,
      PL_TARGET_DENSITY_PCT: "expr::($FP_CORE_UTIL + 10)",
      CUSTOM: [1, 2],
    },
  },
};
describe("project settings drafts", () => {
  it("round trips existing settings without losing roots, hierarchy, models or expression overrides", () => {
    expect(settingsProject(settingsDraft(project))).toEqual(project);
  });
  it("keeps a design without a clock as no clock port, shown as an empty field", () => {
    const clockless = {
      ...project,
      physical: project.physical && { ...project.physical, clock_port: null },
    };
    const draft = settingsDraft(clockless);
    expect(draft.physical?.clock_port).toBe("");
    expect(settingsProject(draft)).toEqual(clockless);
  });
  it("keeps further clocks with their periods and writes them only when used", () => {
    const draft = settingsDraft(project);
    expect(settingsProject(draft).physical).not.toHaveProperty(
      "additional_clocks",
    );
    if (!draft.physical)
      throw new Error("fixture has a physical configuration");
    draft.physical.additional_clocks = [["rd_clk", "12.5"]];
    draft.physical.related_clocks = true;
    const saved = settingsProject(draft);
    expect(saved.physical).toMatchObject({
      additional_clocks: [{ port: "rd_clk", period_ns: 12.5 }],
      related_clocks: true,
    });
    expect(settingsProject(settingsDraft(saved))).toEqual(saved);
    draft.physical.additional_clocks = [["rd_clk", ""]];
    expect(() => settingsProject(draft)).toThrow("Enter a port and a period");
  });
  it("creates explicit simulation defaults without inventing names or hierarchy", () => {
    const config = newSimulation(project.simulation_sources ?? []);
    expect(config.top).toBe("");
    expect(config.dut_scope).toEqual([]);
    expect(config.testbench).toEqual(simulation.testbench);
    expect(config.duration + config.unit).toBe("1us");
    expect(config.simulator).toBe("icarus");
    expect(uniqueSimulationName(["default", "default_2"])).toBe("default_3");
  });
  it("rejects duplicate names and invalid override objects instead of dropping input", () => {
    const draft = settingsDraft(project);
    draft.defines.push(["WIDTH", "8"]);
    expect(() => settingsProject(draft)).toThrow("Duplicate name");
    draft.defines.pop();
    if (draft.physical) draft.physical.overrides = "[]";
    expect(() => settingsProject(draft)).toThrow("JSON object");
  });
  it("rebases imported sources and defines without overwriting unapplied settings edits", () => {
    const draft = settingsDraft(project);
    draft.top = "changed";
    draft.simulations.extra = newSimulation([]);
    draft.defines = [["WIDTH", "8"]];
    draft.include_dirs = ["custom include"];
    const imported = {
      ...project,
      simulation_sources: [...simulation.testbench, "second_tb.sv"],
      defines: { WIDTH: "16", NEW: "1" },
      include_dirs: ["include", "new include"],
      source_roots: { ...project.source_roots, second: "../second" },
    };
    const merged = rebaseSettings(draft, project, imported);
    expect(merged.top).toBe("changed");
    expect(merged.defines).toEqual([
      ["WIDTH", "8"],
      ["NEW", "1"],
    ]);
    expect(merged.include_dirs).toEqual(["custom include", "new include"]);
    expect(merged.simulation_sources).toEqual(imported.simulation_sources);
    expect(merged.simulations.extra).toBeDefined();
    expect(merged.source_roots).toHaveProperty("second");
  });
});
