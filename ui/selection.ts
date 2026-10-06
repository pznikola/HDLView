export interface Selection {
  origin: "schematic" | "waveform" | "hierarchy";
  sequence: number;
  signalId?: string;
  variableId?: number;
  scope?: string[];
}
export function nextSelection(
  previous: Selection | undefined,
  update: Omit<Selection, "sequence">,
): Selection {
  return { ...update, sequence: (previous?.sequence ?? 0) + 1 };
}
export function position(
  time: bigint,
  start: bigint,
  end: bigint,
  width: number,
): number {
  return (
    Number(
      ((time - start) * BigInt(Math.round(width) * 1024)) / (end - start || 1n),
    ) / 1024
  );
}
export function formatValue(value: string, radix: string): string {
  if (value.startsWith("activity:"))
    return "⋮ " + formatValue(value.slice(9), radix);
  if (radix === "bin" || !/^[01]+$/.test(value)) return value;
  const n = BigInt("0b" + value);
  if (radix === "signed") {
    const sign = 1n << BigInt(value.length - 1);
    return (n >= sign ? n - (sign << 1n) : n).toString();
  }
  return radix === "hex" ? "0x" + n.toString(16) : n.toString();
}
