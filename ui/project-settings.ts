import { fileKey } from "./projects";
import type {
  FileRef,
  Floorplan,
  PhysicalConfig,
  Project,
  SettingsSection,
  SimulationConfig,
} from "./types";

export type SettingPair = [string, string];
export interface SimulationDraft
  extends Omit<SimulationConfig, "defines" | "stop_time"> {
  defines: SettingPair[];
  duration: string;
  unit: string;
}
interface PhysicalDraft
  extends Omit<
    PhysicalConfig,
    | "clock_port"
    | "clock_period_ns"
    | "additional_clocks"
    | "related_clocks"
    | "flatten_mapped"
    | "floorplan"
    | "overrides"
  > {
  clock_port: string;
  clock_period_ns: string;
  /** Port and period of each further clock. */
  additional_clocks: SettingPair[];
  related_clocks: boolean;
  flatten_mapped: boolean;
  overrides: string;
  utilization: string;
  density: string;
  /** A fixed block outline; the flow sizes the block when it is off. */
  fixed: boolean;
  width: string;
  height: string;
  pins: Floorplan["pins"];
}
export interface SettingsDraft
  extends Omit<Project, "defines" | "parameters" | "simulations" | "physical"> {
  defines: SettingPair[];
  parameters: SettingPair[];
  simulations: Record<string, SimulationDraft>;
  physical?: PhysicalDraft | null;
}
export const settingsSections: { id: SettingsSection; label: string }[] = [
  { id: "general", label: "General" },
  { id: "sources", label: "Sources" },
  { id: "simulation", label: "Simulation" },
  { id: "physical", label: "Physical Design" },
  { id: "editor", label: "Editor" },
];
export function technologyPreset(technology: Project["technology"]) {
  return technology === "ihp_sg13g2"
    ? { pdk: "ihp-sg13g2", library: "sg13g2_stdcell" }
    : { pdk: "sky130A", library: "sky130_fd_sc_hd" };
}
export function physicalDraft(
  technology: Project["technology"],
): PhysicalDraft {
  return {
    ...technologyPreset(technology),
    clock_port: "",
    clock_period_ns: "",
    additional_clocks: [],
    related_clocks: false,
    flatten_mapped: false,
    overrides: "{}",
    utilization: "",
    density: "",
    fixed: false,
    width: "",
    height: "",
    pins: [],
  };
}
function withoutFloorplan(physical: PhysicalConfig) {
  const rest = { ...physical };
  delete rest.floorplan;
  return rest;
}
export function settingsDraft(project: Project): SettingsDraft {
  const p = structuredClone(project);
  const physical = p.physical;
  const overrides = { ...physical?.overrides };
  const utilization =
    typeof overrides.FP_CORE_UTIL === "number"
      ? String(overrides.FP_CORE_UTIL)
      : "";
  const density =
    typeof overrides.PL_TARGET_DENSITY_PCT === "number"
      ? String(overrides.PL_TARGET_DENSITY_PCT)
      : "";
  if (utilization) delete overrides.FP_CORE_UTIL;
  if (density) delete overrides.PL_TARGET_DENSITY_PCT;
  return {
    ...p,
    defines: Object.entries(p.defines),
    parameters: Object.entries(p.parameters),
    physical: physical
      ? {
          ...withoutFloorplan(physical),
          fixed: !!physical.floorplan,
          width: String(physical.floorplan?.width_um ?? ""),
          height: String(physical.floorplan?.height_um ?? ""),
          pins: physical.floorplan?.pins ?? [],
          clock_port: physical.clock_port ?? "",
          clock_period_ns: String(physical.clock_period_ns),
          additional_clocks: (physical.additional_clocks ?? []).map(
            (clock): SettingPair => [clock.port, String(clock.period_ns)],
          ),
          related_clocks: physical.related_clocks ?? false,
          flatten_mapped: physical.flatten_mapped ?? false,
          overrides: JSON.stringify(overrides, null, 2),
          utilization,
          density,
        }
      : physical,
    simulations: Object.fromEntries(
      Object.entries(p.simulations).map(([name, s]) => {
        const time = /^(\d+)(.*)$/.exec(s.stop_time);
        return [
          name,
          {
            ...s,
            defines: Object.entries(s.defines),
            duration: time?.[1] ?? s.stop_time,
            unit: time?.[2] ?? "us",
          },
        ];
      }),
    ),
  };
}
export class SettingsDraftError extends Error {
  constructor(
    public field: string,
    message: string,
  ) {
    super(message);
  }
}
function pairs(rows: SettingPair[], field: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of rows) {
    const key = name.trim();
    if (!key)
      throw new SettingsDraftError(
        field,
        "Enter a name or remove the empty row",
      );
    if (Object.hasOwn(result, key))
      throw new SettingsDraftError(field, `Duplicate name: ${key}`);
    Object.defineProperty(result, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}
export function settingsProject(draft: SettingsDraft): Project {
  const { defines, parameters, simulations, physical, ...project } = draft;
  let flow: PhysicalConfig | null | undefined = physical ? undefined : physical;
  if (physical) {
    let overrides: unknown;
    try {
      overrides = JSON.parse(physical.overrides);
    } catch {
      throw new SettingsDraftError(
        "physical.overrides",
        "LibreLane overrides must be valid JSON",
      );
    }
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides))
      throw new SettingsDraftError(
        "physical.overrides",
        "LibreLane overrides must be a JSON object",
      );
    const values: Record<string, unknown> = Object.fromEntries(
      Object.entries(overrides),
    );
    for (const [key, text] of [
      ["FP_CORE_UTIL", physical.utilization],
      ["PL_TARGET_DENSITY_PCT", physical.density],
    ] as const) {
      if (!text) continue;
      const value = Number(text);
      if (!Number.isFinite(value) || value <= 0 || value > 100)
        throw new SettingsDraftError(
          `physical.${key}`,
          "Enter a percentage greater than 0 and at most 100",
        );
      if (Object.hasOwn(values, key))
        throw new SettingsDraftError(
          "physical.overrides",
          `${key} is already set by its percentage control`,
        );
      values[key] = value;
    }
    const period = Number(physical.clock_period_ns);
    if (!Number.isFinite(period))
      throw new SettingsDraftError(
        "physical.clock_period_ns",
        "Clock period must be a number",
      );
    const clocks = physical.additional_clocks.map(([name, text]) => {
      const port = name.trim(),
        period_ns = Number(text);
      if (!port || !text.trim() || !Number.isFinite(period_ns))
        throw new SettingsDraftError(
          "physical.additional_clocks",
          "Enter a port and a period in ns for each clock, or remove the row",
        );
      return { port, period_ns };
    });
    const width_um = Number(physical.width),
      height_um = Number(physical.height);
    if (physical.fixed && !(width_um > 0 && height_um > 0))
      throw new SettingsDraftError(
        "physical.floorplan",
        "Enter the floorplan width and height in µm",
      );
    flow = {
      pdk: physical.pdk,
      library: physical.library,
      // An empty field is a design without a clock.
      clock_port: physical.clock_port.trim() || null,
      sdc: physical.sdc,
      overrides: values,
      clock_period_ns: period,
      // Written only when used, so other project files stay as they are.
      ...(clocks.length
        ? {
            additional_clocks: clocks,
            ...(physical.related_clocks ? { related_clocks: true } : {}),
          }
        : {}),
      ...(physical.flatten_mapped ? { flatten_mapped: true } : {}),
      ...(physical.fixed
        ? { floorplan: { width_um, height_um, pins: physical.pins } }
        : {}),
    };
  }
  return {
    ...project,
    defines: pairs(defines, "defines"),
    parameters: pairs(parameters, "parameters"),
    physical: flow,
    simulations: Object.fromEntries(
      Object.entries(simulations).map(([name, s]) => {
        const { duration, unit, defines, ...config } = s;
        return [
          name,
          {
            ...config,
            defines: pairs(defines, `simulations.${name}.defines`),
            stop_time: `${duration}${unit}`,
          },
        ];
      }),
    ),
  };
}
export function newSimulation(files: FileRef[]): SimulationDraft {
  return {
    simulator: "icarus",
    top: "",
    dut_scope: [],
    testbench: [...files],
    models: [],
    args: [],
    defines: [],
    sdf: null,
    duration: "1",
    unit: "us",
    timing_corner: null,
    delay_selection: null,
    use_snapshot_sdf: false,
  };
}
export function uniqueSimulationName(
  names: string[],
  stem = "default",
): string {
  if (!names.includes(stem)) return stem;
  let index = 2;
  while (names.includes(`${stem}_${index}`)) index++;
  return `${stem}_${index}`;
}
export function settingsReference(label: string): FileRef {
  const match = /^@([^/]+)\/(.*)$/.exec(label);
  return match?.[1] && match[2] !== undefined
    ? { root: match[1], path: match[2] }
    : label;
}
export function issueSection(field: string): SettingsSection {
  if (field.startsWith("simulations")) return "simulation";
  if (field.startsWith("physical")) return "physical";
  if (
    ["defines", "parameters", "include_dirs", "sources", "source_roots"].some(
      (prefix) => field.startsWith(prefix),
    )
  )
    return "sources";
  return "general";
}

// Imports publish membership independently; preserve settings edits while adopting those changes.
export function rebaseSettings(
  draft: SettingsDraft,
  base: Project,
  current: Project,
): SettingsDraft {
  const original = settingsDraft(base);
  const next = settingsDraft(current);
  const equal = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  const updated = { ...next };
  for (const key of [
    "name",
    "top",
    "standard",
    "technology",
    "physical",
    "parameters",
    "simulations",
  ] as const) {
    if (!equal(draft[key], original[key]))
      Object.assign(updated, { [key]: draft[key] });
  }
  updated.source_roots = { ...next.source_roots, ...draft.source_roots };
  if (!equal(draft.sources, original.sources)) {
    updated.sources = [
      ...draft.sources,
      ...next.sources.filter(
        (s) => !draft.sources.some((d) => fileKey(d.path) === fileKey(s.path)),
      ),
    ];
  }
  if (!equal(draft.include_dirs, original.include_dirs)) {
    updated.include_dirs = [
      ...draft.include_dirs,
      ...next.include_dirs.filter(
        (f) =>
          !original.include_dirs.some((o) => fileKey(o) === fileKey(f)) &&
          !draft.include_dirs.some((o) => fileKey(o) === fileKey(f)),
      ),
    ];
  }
  if (!equal(draft.defines, original.defines)) {
    updated.defines = draft.defines.map(([key, value]) => {
      const old = original.defines.find(([name]) => name === key);
      const imported = next.defines.find(([name]) => name === key);
      return old?.[1] === value && imported ? imported : [key, value];
    });
    updated.defines.push(
      ...next.defines.filter(
        ([key]) =>
          !original.defines.some(([name]) => name === key) &&
          !draft.defines.some(([name]) => name === key),
      ),
    );
  }
  return updated;
}
