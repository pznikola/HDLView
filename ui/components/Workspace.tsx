import { useEffect, useRef, useState, type ReactNode } from "react";

function ResizeHandle({
  label,
  orientation,
  value,
  min,
  max,
  step,
  unit = "percent",
  reverse = false,
  onChange,
}: {
  label: string;
  orientation: "horizontal" | "vertical";
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: "percent" | "pixels";
  reverse?: boolean;
  onChange: (value: number) => void;
}) {
  function change(next: number) {
    onChange(Math.min(max, Math.max(min, next)));
  }
  return (
    <div
      className={`resize-handle ${orientation}`}
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      aria-valuenow={Math.round(value)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      aria-valuetext={`${Math.round(value)}${unit === "percent" ? "%" : " pixels"}`}
      tabIndex={0}
      onKeyDown={(event) => {
        const decrease = orientation === "vertical" ? "ArrowLeft" : "ArrowUp";
        const increase =
          orientation === "vertical" ? "ArrowRight" : "ArrowDown";
        if (![decrease, increase, "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        change(
          event.key === "Home"
            ? min
            : event.key === "End"
              ? max
              : value +
                (event.key === increase ? 1 : -1) * (reverse ? -step : step),
        );
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const bounds =
          event.currentTarget.parentElement?.getBoundingClientRect();
        if (!bounds) return;
        const vertical = orientation === "vertical";
        const size = vertical ? bounds.width : bounds.height;
        const thickness = vertical
          ? event.currentTarget.offsetWidth
          : event.currentTarget.offsetHeight;
        const position = vertical
          ? event.clientX - bounds.left
          : event.clientY - bounds.top;
        const available = size - thickness;
        const distance = reverse
          ? size - position - thickness / 2
          : position - thickness / 2;
        if (available > 0)
          change(
            distance *
              (unit === "percent" ? 100 / (reverse ? size : available) : 1),
          );
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
    />
  );
}

export function Workspace({
  sidebar,
  panel,
  panelOpen,
  inert,
  children,
}: {
  sidebar: ReactNode;
  panel: ReactNode;
  panelOpen: boolean;
  inert: boolean;
  children: ReactNode;
}) {
  const container = useRef<HTMLElement>(null);
  const [bounds, setBounds] = useState({ width: 1000, height: 600 });
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [panelHeight, setPanelHeight] = useState(35);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (entry)
        setBounds({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
    });
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const sidebarMax = Math.max(224, Math.min(420, bounds.width - 366));
  const width = Math.min(sidebarMax, Math.max(224, sidebarWidth));
  // Leave room for editor/schematic controls even at the panel's largest size.
  const panelMax = Math.max(
    0,
    Math.min(65, (100 * (bounds.height - 266)) / bounds.height),
  );
  const panelMin = Math.min(panelMax, (100 * 140) / bounds.height);
  const height = Math.min(panelMax, Math.max(panelMin, panelHeight));
  return (
    <main
      className="workspace-layout"
      ref={container}
      inert={inert}
      style={{
        gridTemplateRows: panelOpen
          ? `minmax(0, 1fr) 6px ${height}%`
          : "minmax(0, 1fr) 36px",
      }}
    >
      <div
        className="workspace-top"
        style={{ gridTemplateColumns: `${width}px 6px minmax(0,1fr)` }}
      >
        {sidebar}
        <ResizeHandle
          label="Sidebar width"
          orientation="vertical"
          unit="pixels"
          value={width}
          min={224}
          max={sidebarMax}
          step={20}
          onChange={setSidebarWidth}
        />
        <div className="workspace">{children}</div>
      </div>
      {panelOpen && (
        <ResizeHandle
          label="Bottom panel height"
          orientation="horizontal"
          reverse
          value={height}
          min={panelMin}
          max={panelMax}
          step={5}
          onChange={setPanelHeight}
        />
      )}
      {panel}
    </main>
  );
}

export function EditorSchematic({
  editor,
  schematic,
  editorCollapsed,
  schematicCollapsed,
}: {
  editor?: ReactNode;
  schematic: ReactNode;
  editorCollapsed: boolean;
  schematicCollapsed: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000);
  const [editorWidth, setEditorWidth] = useState(45);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const available = Math.max(1, width - 8);
  const min = Math.max(20, (100 * Math.min(200, available / 2)) / available);
  const max = Math.min(
    80,
    100 - (100 * Math.min(320, available / 2)) / available,
  );
  const percent = Math.min(max, Math.max(min, editorWidth));
  const split = !!editor && !editorCollapsed && !schematicCollapsed;
  return (
    <div
      className="workbench"
      ref={container}
      style={{
        gridTemplateColumns: split
          ? `${(available * percent) / 100}px 8px minmax(0,1fr)`
          : "minmax(0,1fr)",
      }}
    >
      {editor}
      {split && (
        <ResizeHandle
          label="Editor width"
          orientation="vertical"
          value={percent}
          min={min}
          max={max}
          step={5}
          onChange={setEditorWidth}
        />
      )}
      {schematic}
    </div>
  );
}
