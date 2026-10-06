import { describe, it, expect } from "vitest";
import { nextSelection, position, formatValue } from "./selection";
describe("cross-probing and waveform arithmetic", () => {
  it("tracks origin without re-emitting incoming selections", () => {
    const s = nextSelection(undefined, { origin: "schematic", signalId: "a" });
    const w = nextSelection(s, { origin: "waveform", variableId: 3 });
    expect(w.sequence).toBe(2);
    expect(w.signalId).toBeUndefined();
    expect(w.origin).toBe("waveform");
  });
  it("retains small deltas at timestamps above Number precision", () => {
    const start = 90071992547409930n;
    expect(position(start + 1n, start, start + 10n, 1000)).toBe(100);
  });
  it("does not turn unknown values into numeric zero", () => {
    expect(formatValue("10xz", "hex")).toBe("10xz");
    expect(formatValue("1111", "hex")).toBe("0xf");
  });
});
