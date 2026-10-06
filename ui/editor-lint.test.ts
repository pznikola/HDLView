import { describe, expect, it } from "vitest";
import { decodeLintResult, lintContext, lintStatus } from "./editor-lint";
import type { Project, SimulationConfig } from "./types";

const config = (
  testbench: Project["simulation_sources"],
): SimulationConfig => ({
  simulator: "icarus",
  top: "tb",
  dut_scope: ["tb", "dut"],
  testbench: testbench ?? [],
  models: [],
  stop_time: "100ns",
  args: [],
  defines: {},
  use_snapshot_sdf: false,
});
const project: Project = {
  schema_version: 3,
  name: "lint",
  top: "top",
  standard: "1800-2017",
  sources: [
    { path: { root: "rtl", path: "top.sv" }, language: "system_verilog" },
  ],
  headers: ["design.svh"],
  simulation_sources: ["tb.sv", "other.sv"],
  include_dirs: [],
  defines: {},
  parameters: {},
  assets: [],
  simulations: {
    one: config(["tb.sv"]),
    two: config(["tb.sv"]),
    other: config(["other.sv"]),
  },
};
describe("editor analysis contexts", () => {
  it("keeps design analysis independent of simulation selection", () => {
    expect(
      lintContext(project, { root: "rtl", path: "top.sv" }, "one").context,
    ).toEqual({ kind: "design" });
    expect(lintContext(project, "design.svh", "one").context).toEqual({
      kind: "design",
    });
  });
  it("uses owning configurations and leaves ambiguous testbenches limited", () => {
    expect(lintContext(project, "other.sv", "one").context).toEqual({
      kind: "simulation",
      configuration: "other",
    });
    expect(lintContext(project, "tb.sv", "missing").context).toEqual({
      kind: "simulation",
      configuration: null,
    });
    expect(lintContext(project, "tb.sv", "one", "two").context).toEqual({
      kind: "simulation",
      configuration: "two",
    });
    expect(lintContext(project, "tb.sv", "one", "").context).toEqual({
      kind: "simulation",
      configuration: null,
    });
  });
  it("does not match duplicate basenames from different roots", () => {
    expect(
      lintContext(project, { root: "other", path: "top.sv" }, "one").context
        .kind,
    ).toBe("simulation");
  });
});
describe("editor diagnostic boundary", () => {
  const result = {
    generation: 1,
    project_fingerprint: "hash",
    files: [{ file: "top.sv", text_hash: "text" }],
    diagnostics: [
      {
        file: "top.sv",
        from: 1,
        to: 3,
        line: 1,
        column: 2,
        severity: "error",
        engine: "slang",
        code: "undeclared",
        message: "Unknown signal",
        related: [],
      },
    ],
    engines: [{ engine: "slang", status: "complete", message: null }],
    limited: false,
    truncated: false,
  };
  it("preserves typed diagnostics and rejects malformed ranges or status", () => {
    expect(decodeLintResult(result)).toEqual(result);
    expect(() =>
      decodeLintResult({
        ...result,
        diagnostics: [{ ...result.diagnostics[0], to: 0 }],
      }),
    ).toThrow();
    expect(() =>
      decodeLintResult({
        ...result,
        engines: [{ engine: "slang", status: "clean", message: null }],
      }),
    ).toThrow();
  });
  it("distinguishes incomplete style checks from limited semantic analysis", () => {
    const styleIncomplete = decodeLintResult({
      ...result,
      limited: true,
      engines: [
        ...result.engines,
        { engine: "verible", status: "limited", message: "Syntax error" },
      ],
    });
    expect(lintStatus(styleIncomplete)).toBe("Style checks incomplete");
    expect(styleIncomplete.diagnostics).toEqual(result.diagnostics);
    expect(
      lintStatus({
        ...styleIncomplete,
        engines: styleIncomplete.engines.map((engine) => ({
          ...engine,
          status: "limited",
        })),
      }),
    ).toBe("Limited analysis");
  });
  it("identifies unavailable engines independently from their findings", () => {
    const styleUnavailable = decodeLintResult({
      ...result,
      limited: true,
      engines: [
        ...result.engines,
        { engine: "verible", status: "failed", message: "Missing tool" },
      ],
    });
    expect(lintStatus(styleUnavailable)).toBe("Style checks unavailable");
    expect(
      lintStatus({
        ...styleUnavailable,
        engines: styleUnavailable.engines.map((engine) => ({
          ...engine,
          status: "failed",
        })),
      }),
    ).toBe("Correctness checks unavailable");
    expect(lintStatus(decodeLintResult(result))).toBe("Checked");
  });
});
