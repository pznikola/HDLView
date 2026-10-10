import { describe, it, expect } from "vitest";
import { nextSelection, position, formatValue, valueBit } from "./selection";
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
  it("formats a value in each radix", () => {
    expect(formatValue("11111110", "signed")).toBe("-2");
    expect(formatValue("11111110", "dec")).toBe("254");
    expect(formatValue("001111", "oct")).toBe("0o17");
    expect(formatValue("0100100001101001", "ascii")).toBe('"Hi"');
    expect(formatValue("00111111110000000000000000000000", "float")).toBe(
      "1.5",
    );
    // A width that is no IEEE format stays readable.
    expect(formatValue("1111", "float")).toBe("0xf");
  });
  it("shows one bit of a vector for a wire that is that bit", () => {
    expect(valueBit("0100", undefined)).toBe("0100");
    expect(valueBit("0100", 2)).toBe("1");
    expect(valueBit("01x0", 1)).toBe("x");
    expect(valueBit("activity:0100", 0)).toBe("activity:0");
  });
});
