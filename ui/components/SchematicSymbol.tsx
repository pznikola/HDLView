import { pinSelected, pinTarget, type ConnectionTarget } from "../selection";
import type { Node } from "../types";
import {
  pinTitle,
  symbolGeometry,
  type SymbolGeometry,
} from "../schematic-symbols";
export function SchematicSymbol({
  node,
  geometry = symbolGeometry(node),
  selected,
  onSignal,
  target,
  scale = 1,
}: {
  node: Node;
  geometry?: SymbolGeometry;
  selected?: string;
  onSignal?: (ids: string[], target: ConnectionTarget) => void;
  target?: ConnectionTarget;
  scale?: number;
}) {
  return (
    <>
      {geometry.paths.map((path, index) => (
        <path
          key={index}
          d={path.d}
          className={`${path.className ?? "symbol-detail"} ${path.fill ? "symbol-fill" : "symbol-line"}`}
        />
      ))}
      {geometry.texts.map((text, index) => (
        <text
          key={index}
          x={text.x}
          y={text.y}
          textAnchor={text.anchor}
          className={text.secondary ? "symbol-secondary" : "symbol-title"}
        >
          {text.text}
        </text>
      ))}
      {geometry.pins.map((pin) => {
        const port = node.ports.find((p) => p.id === pin.id);
        if (!port) return null;
        const active = pinSelected(port, selected, target);
        const activate = () =>
          onSignal?.(port.signal_ids, pinTarget(node, port));
        const hitSize = Math.max(4, 8 / scale);
        return (
          <g
            key={pin.id}
            className={`symbol-pin ${active ? "selected" : ""}`}
            data-pin={pin.id}
            role={onSignal ? "button" : undefined}
            tabIndex={onSignal ? 0 : undefined}
            aria-label={port.label || port.display.name || "connection"}
            onClick={(event) => {
              event.stopPropagation();
              if (
                event.target instanceof Element &&
                event.target.closest(".pin-hit,.pin-terminal,.port-name")
              )
                activate();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                activate();
              }
            }}
          >
            <title>{pinTitle(node, port)}</title>
            <path
              d={pin.lead}
              className={`symbol-line ${pin.bus ? "bus" : ""}`}
              pointerEvents="none"
            />
            {pin.mark && (
              <path d={pin.mark} className="symbol-line" pointerEvents="none" />
            )}
            {pin.bubble && (
              <circle
                cx={pin.bubble[0]}
                cy={pin.bubble[1]}
                r="4"
                className="inversion"
                pointerEvents="none"
              />
            )}
            {pin.clock && (
              <path
                d={pin.clock}
                className="symbol-line"
                pointerEvents="none"
              />
            )}
            {onSignal && (
              <rect
                x={pin.x - hitSize / 2}
                y={pin.y - hitSize / 2}
                width={hitSize}
                height={hitSize}
                className="pin-hit"
              />
            )}
            {!pin.unwired && (
              <rect
                x={pin.x - 2}
                y={pin.y - 2}
                width="4"
                height="4"
                className="pin-terminal"
              />
            )}
            {pin.note && (
              <text
                x={pin.note.x}
                y={pin.note.y}
                textAnchor={pin.note.anchor}
                dominantBaseline="middle"
                className="pin-note"
              >
                {pin.note.text}
              </text>
            )}
            <text
              x={pin.labelX}
              y={pin.labelY}
              textAnchor={pin.anchor}
              dominantBaseline="middle"
              className="port-name"
            >
              {pin.label}
            </text>
          </g>
        );
      })}
    </>
  );
}
export function schematicStyle(theme: "light" | "dark", interactive = true) {
  const ink = theme === "light" ? "#263746" : "#d6e5ed";
  const paper = theme === "light" ? "#fcfdff" : "#172630";
  const muted = theme === "light" ? "#556e80" : "#9eb9c8";
  const interaction = `.schematic-canvas .symbol-pin:hover .pin-terminal,.schematic-canvas .symbol-pin:focus-visible .pin-terminal{fill:var(--accent);stroke:var(--accent)}.schematic-canvas .wire:hover .edge,.schematic-canvas .wire:focus-visible .edge{stroke:var(--accent)}.schematic-canvas g[role=button]{cursor:pointer}.schematic-canvas g:focus-visible{outline:none}.schematic-canvas g:focus-visible>.nodebox,.schematic-canvas .symbol-pin:focus-visible .symbol-line{stroke:var(--accent);stroke-width:3}`;
  return `.schematic-canvas{background:${paper};--paper:${paper};--ink:${ink};--muted:${muted};--accent:${theme === "light" ? "#087e83" : "#66decf"}}.schematic-canvas .canvas-background{fill:var(--paper)}.schematic-canvas text{font:12px ui-monospace,monospace;fill:var(--ink)}.schematic-canvas .symbol-fill{fill:var(--paper)}.schematic-canvas .nodebox,.schematic-canvas .symbol-detail,.schematic-canvas .symbol-line{stroke:var(--ink);stroke-width:1.5;stroke-linejoin:round}.schematic-canvas .symbol-line{fill:none}.schematic-canvas .symbol-line.bus,.schematic-canvas .join{stroke-width:2.5}.schematic-canvas .join{fill:none;stroke:var(--ink)}.schematic-canvas .inversion{fill:var(--paper);stroke:var(--ink);stroke-width:1.5}.schematic-canvas .pin-hit{fill:transparent;stroke:none}.schematic-canvas .symbol-title{font-weight:600}.schematic-canvas .symbol-secondary,.schematic-canvas .port-name,.schematic-canvas .pin-note,.schematic-canvas .wire-label{font-size:10px;fill:var(--muted)}.schematic-canvas .edge{fill:none;stroke:var(--ink);stroke-width:1.5}.schematic-canvas .edge.bus{stroke-width:2.5}.schematic-canvas .edge-hit{fill:none;stroke:transparent;stroke-width:8;vector-effect:non-scaling-stroke;pointer-events:stroke}.schematic-canvas .junction{fill:var(--ink)}.schematic-canvas .selected .junction{fill:var(--accent)}.schematic-canvas .pin-terminal{fill:var(--paper);stroke:var(--ink);stroke-width:1}.schematic-canvas .selected .pin-terminal{fill:var(--accent);stroke:var(--accent)}.schematic-canvas .edge.context{stroke:var(--accent);opacity:.5}.schematic-canvas .selected .symbol-line,.schematic-canvas .edge.selected,.schematic-canvas .control-connector.selected{stroke:var(--accent);stroke-width:3}.schematic-canvas .object-selected .nodebox{stroke:var(--accent);stroke-width:2.5}.schematic-canvas .wire-label{paint-order:stroke;stroke:var(--paper);stroke-width:4;stroke-linejoin:round}.schematic-canvas.zoomed-out .symbol-secondary,.schematic-canvas.zoomed-out .wire-label{display:none}.schematic-canvas .control-connector{fill:none;stroke:var(--muted);stroke-width:1.5}${interactive ? interaction : ""}`;
}
