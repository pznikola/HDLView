import { describe, expect, it } from "vitest";
import { canSimulate } from "./projects";
import type { SimulationConfig } from "./types";
const shared: SimulationConfig = {
  simulator: "icarus",
  top: "tb",
  dut_scope: ["tb", "dut"],
  testbench: ["tb.sv"],
  models: [],
  stop_time: "100ns",
  args: [],
  defines: {},
  use_snapshot_sdf: false,
};
describe("shared simulation configurations", () => {
  it("allows ordinary configurations across RTL and gate representations", () => {
    for (const representation of [
      "source",
      "elaborated",
      "generic",
      "mapped",
      "post_layout",
    ] as const)
      expect(canSimulate(shared, { representation, sdf: {} })).toBe(true);
  });
  it("requires a gate snapshot, Icarus, and an available SDF selection", () => {
    const config = { ...shared, use_snapshot_sdf: true };
    expect(canSimulate(config)).toBe(false);
    expect(
      canSimulate(config, {
        representation: "elaborated",
        sdf: { typ: "delay.sdf" },
      }),
    ).toBe(false);
    expect(canSimulate(config, { representation: "generic", sdf: {} })).toBe(
      false,
    );
    const snapshot = {
      representation: "post_layout",
      sdf: { typ: "delay.sdf" },
    } as const;
    expect(canSimulate(config, snapshot)).toBe(true);
    expect(canSimulate({ ...config, simulator: "verilator" }, snapshot)).toBe(
      false,
    );
    expect(canSimulate({ ...config, timing_corner: "missing" }, snapshot)).toBe(
      false,
    );
    expect(
      canSimulate(config, {
        ...snapshot,
        sdf: { typ: "typ.sdf", max: "max.sdf" },
      }),
    ).toBe(false);
    expect(
      canSimulate(
        { ...config, timing_corner: "max" },
        { ...snapshot, sdf: { max: "max.sdf", typ: "typ.sdf" } },
      ),
    ).toBe(true);
    expect(canSimulate({ ...shared, sdf: "external.sdf" }, snapshot)).toBe(
      true,
    );
  });
});
