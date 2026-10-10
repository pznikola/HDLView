import { describe, it, expect, beforeEach } from "vitest";
import {
  addTraces,
  formatFrequency,
  formatTime,
  moveTrace,
  pan,
  readTraces,
  readView,
  rulerTicks,
  rulerUnit,
  writeTraces,
  writeView,
  zoomAt,
} from "./wave-layout";
import type { Trace } from "./wave-layout";

const ns = { factor: 1, exponent: -9 };
describe("waveform times", () => {
  it("prints a time exactly in the chosen unit", () => {
    expect(formatTime(1500n, ns, "auto")).toBe("1.5 us");
    expect(formatTime(1500n, ns, "ns")).toBe("1500 ns");
    expect(formatTime(1500n, ns, "ms")).toBe("0.0015 ms");
    expect(formatTime(1500n, ns, "ticks")).toBe("1500");
    expect(formatTime(25n, { factor: 10, exponent: -12 }, "auto")).toBe(
      "250 ps",
    );
    expect(formatTime(-5n, ns, "auto")).toBe("-5 ns");
    expect(formatTime(0n, ns, "auto")).toBe("0");
    expect(formatTime(7n, null, "auto")).toBe("7");
  });
  it("keeps every digit of a time above Number precision", () => {
    expect(formatTime(9007199254740993n, ns, "ns")).toBe("9007199254740993 ns");
    expect(formatTime(9007199254740993n, ns, "s")).toBe("9007199.254740993 s");
  });
  it("uses one unit for a whole ruler and gives a period as a frequency", () => {
    expect(rulerUnit([0n, 2_000_000n], ns, "auto")).toBe("ms");
    expect(rulerUnit([0n, 2_000_000n], ns, "ps")).toBe("ps");
    expect(formatFrequency(10n, ns)).toBe("100 MHz");
  });
  it("puts ruler ticks on round times inside the window", () => {
    const ticks = rulerTicks([130n, 1870n], 900);
    const step = ticks[1]! - ticks[0]!;
    expect(["1", "2", "5"]).toContain(step.toString().replace(/0+$/, ""));
    expect(ticks.every((t) => t % step === 0n && t >= 130n && t <= 1870n)).toBe(
      true,
    );
    expect(ticks.length).toBeGreaterThan(2);
    expect(ticks.length).toBeLessThanOrEqual(10);
  });
});
describe("waveform window", () => {
  it("zooms around the anchor and stays inside the trace", () => {
    const zoomed = zoomAt([0n, 1000n], 250n, 0.5, 1000n);
    expect(zoomed[1] - zoomed[0]).toBe(500n);
    // The anchor was a quarter into the window and still is.
    expect((250n - zoomed[0]) * 4n).toBe(zoomed[1] - zoomed[0]);
    expect(zoomAt([400n, 600n], 500n, 100, 1000n)).toEqual([0n, 1000n]);
    expect(zoomAt([0n, 4n], 2n, 0.001, 1000n)).toEqual([1n, 3n]);
  });
  it("pans until either end of the trace", () => {
    expect(pan([100n, 300n], 50n, 1000n)).toEqual([150n, 350n]);
    expect(pan([100n, 300n], -500n, 1000n)).toEqual([0n, 200n]);
    expect(pan([100n, 300n], 5000n, 1000n)).toEqual([800n, 1000n]);
  });
});
describe("trace list", () => {
  beforeEach(() => {
    const items = new Map<string, string>();
    globalThis.localStorage = {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
    } as Storage;
  });
  const list: Trace[] = [
    { path: ["tb", "a"] },
    { divider: "Data" },
    { path: ["tb", "b"], radix: "signed", expanded: true },
  ];
  it("adds a signal once and moves a row before another", () => {
    expect(addTraces(list, [["tb", "a"]])).toBe(list);
    expect(
      addTraces(list, [
        ["tb", "c"],
        ["tb", "c"],
      ]),
    ).toHaveLength(4);
    expect(moveTrace(list, 2, 0)[0]).toBe(list[2]);
    expect(moveTrace(list, 0, 3)[2]).toBe(list[0]);
    expect(moveTrace(list, 0, 1)).toBe(list);
  });
  it("restores what was saved for a key and ignores damaged entries", () => {
    expect(readTraces("p")).toBeUndefined();
    writeTraces("p", list);
    expect(readTraces("p")).toEqual(list);
    localStorage.setItem(
      "hdlview-waves:p",
      JSON.stringify([{ path: "a" }, 3, { path: ["x"], radix: "roman" }]),
    );
    expect(readTraces("p")).toEqual([{ path: ["x"] }]);
    expect(readView("p").radix).toBe("hex");
    writeView("p", { ...readView("p"), cursor: "42", unit: "ps" });
    expect(readView("p")).toMatchObject({ cursor: "42", unit: "ps" });
    expect(readView("other").cursor).toBe("0");
  });
});
