export type ConnectionTarget =
  | { kind: "pin"; nodeId: string; portId: string }
  | { kind: "wire"; edgeId: string; wireId: string };
/** A pin is highlighted as the explicit target, or else by the selected signal. */
export function pinSelected(
  port: { id: string; signal_ids: string[] },
  selected: string | undefined,
  target: ConnectionTarget | undefined,
): boolean {
  return target
    ? target.kind === "pin" && target.portId === port.id
    : port.signal_ids.includes(selected ?? "");
}
export function pinTarget(
  node: { id: string },
  port: { id: string },
): ConnectionTarget {
  return { kind: "pin", nodeId: node.id, portId: port.id };
}
export interface Selection {
  origin: "schematic" | "waveform" | "hierarchy";
  sequence: number;
  signalId?: string;
  variableId?: number;
  scope?: string[];
  connection?: ConnectionTarget;
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
/** One bit of a binary value, counted from the right; the value when no bit is given. */
export function valueBit(value: string, bit: number | undefined): string {
  if (bit === undefined) return value;
  const activity = value.startsWith("activity:") ? "activity:" : "";
  return activity + (value.slice(activity.length).at(-1 - bit) ?? "");
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
