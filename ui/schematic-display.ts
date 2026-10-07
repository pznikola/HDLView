import type { SchematicOptions } from "./types";
export interface SchematicPreferences extends Omit<SchematicOptions, "detail"> {
  theme: "light" | "dark";
  grid: boolean;
}
export const defaultSchematicPreferences: SchematicPreferences = {
  theme: "light",
  grid: false,
  functional_symbols: true,
  full_control_wiring: false,
  show_physical_cells: false,
};
export function readSchematicPreferences(): SchematicPreferences {
  try {
    const saved: unknown = JSON.parse(
      localStorage.getItem("hdlview-schematic-display") ?? "null",
    );
    if (!saved || typeof saved !== "object") return defaultSchematicPreferences;
    return {
      theme: "theme" in saved && saved.theme === "dark" ? "dark" : "light",
      grid: "grid" in saved && saved.grid === true,
      functional_symbols: !(
        "functional_symbols" in saved && saved.functional_symbols === false
      ),
      full_control_wiring:
        "full_control_wiring" in saved && saved.full_control_wiring === true,
      show_physical_cells:
        "show_physical_cells" in saved && saved.show_physical_cells === true,
    };
  } catch {
    return defaultSchematicPreferences;
  }
}
