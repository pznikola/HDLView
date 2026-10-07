import { useState } from "react";
import type { Node, Port, PinDisplay } from "../types";
import { symbolGeometry } from "../schematic-symbols";
import { SchematicSymbol, schematicStyle } from "./SchematicSymbol";

function pin(
  name: string,
  direction: string,
  role: PinDisplay["role"] = "data",
  polarity = true,
): Port {
  return {
    id: name,
    label: name,
    direction,
    signal_ids: [],
    display: { name, width: 1, bits: [name], role, polarity },
  };
}
const data = [pin("A", "input"), pin("B", "input"), pin("Y", "output")];
const symbols: [string, string, Port[]][] = [
  ...["and", "nand", "or", "nor", "xor", "xnor"].map(
    (name): [string, string, Port[]] => [name, name.toUpperCase(), data],
  ),
  ["buffer", "BUF", [pin("A", "input"), pin("Y", "output")]],
  ["not", "NOT", [pin("A", "input"), pin("Y", "output")]],
  [
    "buffer",
    "TRI",
    [pin("A", "input"), pin("EN", "input", "enable"), pin("Y", "output")],
  ],
  ["mux", "MUX", [...data, pin("S", "input", "select")]],
  [
    "demux",
    "DEMUX",
    [
      pin("A", "input"),
      pin("S", "input", "select"),
      pin("Y0", "output"),
      pin("Y1", "output"),
    ],
  ],
  [
    "register",
    "DFF",
    [
      pin("D", "input"),
      pin("CLK", "input", "clock", true),
      pin("RESET", "input", "reset", false),
      pin("Q", "output"),
    ],
  ],
  [
    "register",
    "DFF ↓",
    [
      pin("D", "input"),
      pin("CLK", "input", "clock", false),
      pin("EN", "input", "enable", true),
      pin("Q", "output"),
    ],
  ],
  [
    "latch",
    "LATCH",
    [pin("D", "input"), pin("EN", "input", "enable", true), pin("Q", "output")],
  ],
  ["operator", "+", data],
  ["operator", "≥", data],
  ["operator", "≫", data],
  [
    "decoder",
    "DEC 2 → 4",
    [pin("A", "input"), ...[0, 1, 2, 3].map((i) => pin(`[${i}]`, "output"))],
  ],
  [
    "encoder",
    "PRI ENC 4 → 2",
    [...[0, 1, 2, 3].map((i) => pin(`[${i}]`, "input")), pin("Y", "output")],
  ],
  [
    "memory",
    "MEM 8 × 8",
    [
      pin("ADDR", "input"),
      pin("DATA", "input"),
      pin("WE", "input", "enable"),
      pin("Q", "output"),
    ],
  ],
  [
    "compound",
    "a21oi",
    [
      pin("A1", "input"),
      pin("A2", "input"),
      pin("B1", "input"),
      pin("Y", "output"),
    ],
  ],
  ["process", "AlwaysFF", [pin("count", "input"), pin("count", "output")]],
  ["function", "increment", [pin("value", "input"), pin("return", "output")]],
  ["task", "accumulate", [pin("value", "input")]],
  ["module", "lane", [pin("enable", "input"), pin("count", "output")]],
  ["unknown", "custom_cell", data],
  ...["input", "output", "inout"].map((direction): [string, string, Port[]] => [
    "port",
    direction,
    [
      {
        ...pin(direction, direction === "input" ? "output" : "input"),
        display: {
          name: direction,
          width: 1,
          bits: [direction],
          role: "data",
          declared_direction: direction,
        },
      },
    ],
  ]),
  ["constant", "4'b1010", [pin("Y", "output")]],
];

/** Deliberate visual qualification route; uses the production geometry and styles. */
export function SymbolGallery() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  return (
    <main className="symbol-gallery">
      <header>
        <h1>HDLView schematic symbols</h1>
        <button onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
          Theme: {theme}
        </button>
      </header>
      <div className="symbol-gallery-grid">
        {symbols.map(([symbol, title, pins], index) => {
          const node: Node = {
            id: String(index),
            label: title,
            kind: symbol,
            ports: pins.map((p, i) => ({ ...p, id: `${index}:${i}` })),
            display: {
              symbol,
              title,
              annotations: [],
              members: [],
              internal_signal_ids: [],
              physical_only: false,
            },
          };
          const geometry = symbolGeometry(node);
          return (
            <figure key={index}>
              <figcaption>{title}</figcaption>
              <svg
                aria-label={title}
                className="schematic-canvas"
                viewBox={`-12 -8 ${geometry.width + 24} ${geometry.height + 16}`}
                style={{ height: 180 }}
              >
                <style>{schematicStyle(theme)}</style>
                <rect
                  className="canvas-background"
                  x="-12"
                  y="-8"
                  width={geometry.width + 24}
                  height={geometry.height + 16}
                />
                <SchematicSymbol node={node} />
              </svg>
            </figure>
          );
        })}
      </div>
    </main>
  );
}
