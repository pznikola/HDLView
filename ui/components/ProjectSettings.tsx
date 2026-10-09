import { useEffect, useRef, useState } from "react";
import type { ProjectController } from "../project-workspace";
import type { LintPreferences } from "../editor-lint";
import { fileKey, fileLabel, pick, projects } from "../projects";
import {
  issueSection,
  newSimulation,
  physicalDraft,
  rebaseSettings,
  settingsDraft,
  SettingsDraftError,
  settingsProject,
  settingsReference,
  settingsSections,
  technologyPreset,
  uniqueSimulationName,
} from "../project-settings";
import type {
  SettingPair,
  SettingsDraft,
  SimulationDraft,
} from "../project-settings";
import type {
  FileRef,
  SettingsInputKind,
  SettingsIssue,
  Snapshot,
} from "../types";

function move<T>(entries: T[], index: number, delta: number): T[] {
  const result = [...entries];
  const entry = result[index];
  const target = result[index + delta];
  if (entry !== undefined && target !== undefined) {
    result[index] = target;
    result[index + delta] = entry;
  }
  return result;
}
function PairEditor({
  label,
  rows,
  onChange,
  placeholders = ["NAME", "Value"],
  setting,
}: {
  label: string;
  rows: SettingPair[];
  onChange: (rows: SettingPair[]) => void;
  placeholders?: [string, string];
  setting?: string;
}) {
  return (
    <fieldset className="settings-list" data-setting={setting}>
      <legend>{label}</legend>
      {rows.map(([name, value], index) => (
        <div className="settings-pair" key={index}>
          <input
            aria-label={`${label} name ${index + 1}`}
            placeholder={placeholders[0]}
            value={name}
            onChange={(e) =>
              onChange(
                rows.map((row, i) =>
                  i === index ? [e.target.value, row[1]] : row,
                ),
              )
            }
          />
          <input
            aria-label={`${label} value ${index + 1}`}
            placeholder={placeholders[1]}
            value={value}
            onChange={(e) =>
              onChange(
                rows.map((row, i) =>
                  i === index ? [row[0], e.target.value] : row,
                ),
              )
            }
          />
          <button
            aria-label={`Remove ${label} row ${index + 1}`}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            ×
          </button>
        </div>
      ))}
      <button onClick={() => onChange([...rows, ["", ""]])}>Add {label}</button>
    </fieldset>
  );
}
function ReferenceEditor({
  label,
  files,
  onChange,
  onBrowse,
}: {
  label: string;
  files: FileRef[];
  onChange: (files: FileRef[]) => void;
  onBrowse: () => void;
}) {
  return (
    <fieldset className="settings-list">
      <legend>{label}</legend>
      {files.map((file, index) => (
        <div className="settings-reference" key={index}>
          <input
            aria-label={`${label} path ${index + 1}`}
            value={fileLabel(file)}
            onChange={(e) =>
              onChange(
                files.map((f, i) =>
                  i === index ? settingsReference(e.target.value) : f,
                ),
              )
            }
          />
          <button
            aria-label={`Move ${label} ${index + 1} up`}
            disabled={index === 0}
            onClick={() => onChange(move(files, index, -1))}
          >
            ↑
          </button>
          <button
            aria-label={`Move ${label} ${index + 1} down`}
            disabled={index === files.length - 1}
            onClick={() => onChange(move(files, index, 1))}
          >
            ↓
          </button>
          <button
            aria-label={`Remove ${label} ${index + 1}`}
            onClick={() => onChange(files.filter((_, i) => i !== index))}
          >
            ×
          </button>
        </div>
      ))}
      <div className="settings-actions">
        <button onClick={onBrowse}>Browse {label}…</button>
        <button onClick={() => onChange([...files, ""])}>
          Add {label} path
        </button>
      </div>
      <p className="hint">
        Project-relative paths or @root/path. External selections register a
        source root when settings are applied.
      </p>
    </fieldset>
  );
}
function ArgumentsEditor({
  args,
  onChange,
}: {
  args: string[];
  onChange: (args: string[]) => void;
}) {
  return (
    <fieldset className="settings-list">
      <legend>Runtime arguments</legend>
      {args.map((value, index) => (
        <div className="settings-reference" key={index}>
          <input
            aria-label={`Runtime argument ${index + 1}`}
            value={value}
            onChange={(e) =>
              onChange(args.map((v, i) => (i === index ? e.target.value : v)))
            }
          />
          <button
            aria-label={`Move runtime argument ${index + 1} up`}
            disabled={index === 0}
            onClick={() => onChange(move(args, index, -1))}
          >
            ↑
          </button>
          <button
            aria-label={`Move runtime argument ${index + 1} down`}
            disabled={index === args.length - 1}
            onClick={() => onChange(move(args, index, 1))}
          >
            ↓
          </button>
          <button
            aria-label={`Remove runtime argument ${index + 1}`}
            onClick={() => onChange(args.filter((_, i) => i !== index))}
          >
            ×
          </button>
        </div>
      ))}
      <button onClick={() => onChange([...args, ""])}>
        Add runtime argument
      </button>
      <p className="hint">
        Each row is one literal argument, for example +seed=1. No shell
        expansion is performed.
      </p>
    </fieldset>
  );
}
function SimulationSettings({
  draft,
  selected,
  onSelect,
  onChange,
  onImport,
  onBrowse,
  snapshot,
}: {
  draft: SettingsDraft;
  selected: string;
  onSelect: (name: string) => void;
  onChange: (draft: SettingsDraft) => void;
  onImport: () => void;
  onBrowse: (
    kind: SettingsInputKind,
    apply: (files: FileRef[], current: SettingsDraft) => SettingsDraft,
  ) => void;
  snapshot?: Snapshot;
}) {
  const [rename, setRename] = useState<{ from: string; to: string }>();
  const [error, setError] = useState("");
  const names = Object.keys(draft.simulations);
  const config = draft.simulations[selected];
  const change = (value: SimulationDraft) =>
    onChange({
      ...draft,
      simulations: { ...draft.simulations, [selected]: value },
    });
  const add = (duplicate = false) => {
    const name = uniqueSimulationName(
      names,
      duplicate ? `${selected}_copy` : "default",
    );
    onChange({
      ...draft,
      simulations: {
        ...draft.simulations,
        [name]:
          duplicate && config
            ? structuredClone(config)
            : newSimulation(draft.simulation_sources ?? []),
      },
    });
    onSelect(name);
    setError("");
  };
  const candidates = [...(draft.simulation_sources ?? [])];
  for (const file of config?.testbench ?? [])
    if (!candidates.some((f) => fileKey(f) === fileKey(file)))
      candidates.push(file);
  const sdfMode = config?.use_snapshot_sdf
    ? "snapshot"
    : config?.sdf != null
      ? "external"
      : "none";
  return (
    <>
      <div className="settings-actions">
        <button onClick={() => add()}>Add Simulation Configuration</button>
        <button onClick={onImport}>Add Simulation Sources…</button>
      </div>
      {!names.length && (
        <p>
          No simulation is configured. Add a configuration, then enter the
          testbench top and the DUT instance path.
        </p>
      )}
      {!!names.length && (
        <label>
          Configuration
          <select
            aria-label="Settings simulation configuration"
            value={selected}
            onChange={(e) => {
              onSelect(e.target.value);
              setError("");
            }}
          >
            {names.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
      )}
      {config && (
        <>
          <div className="settings-actions">
            <button onClick={() => add(true)}>Duplicate Configuration</button>
            <button
              onClick={() => {
                const remaining = Object.fromEntries(
                  Object.entries(draft.simulations).filter(
                    ([name]) => name !== selected,
                  ),
                );
                onChange({ ...draft, simulations: remaining });
                onSelect(Object.keys(remaining)[0] ?? "");
              }}
            >
              Delete Configuration
            </button>
          </div>
          <p className="hint">
            Configuration changes do not delete sources or historical simulation
            runs.
          </p>
          <label>
            Configuration name
            <div className="settings-actions">
              <input
                aria-label="Configuration name"
                value={rename?.from === selected ? rename.to : selected}
                onChange={(e) =>
                  setRename({ from: selected, to: e.target.value })
                }
              />
              <button
                onClick={() => {
                  const name = (
                    rename?.from === selected ? rename.to : selected
                  ).trim();
                  if (
                    !name ||
                    (name !== selected &&
                      Object.hasOwn(draft.simulations, name))
                  ) {
                    setError("Enter a unique, nonempty configuration name");
                    return;
                  }
                  onChange({
                    ...draft,
                    simulations: Object.fromEntries(
                      Object.entries(draft.simulations).map(([key, value]) => [
                        key === selected ? name : key,
                        value,
                      ]),
                    ),
                  });
                  onSelect(name);
                  setRename(undefined);
                  setError("");
                }}
              >
                Rename Configuration
              </button>
            </div>
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <label>
            Simulator
            <select
              data-setting={`simulations.${selected}.simulator`}
              aria-label="Simulator"
              value={config.simulator}
              onChange={(e) =>
                change({
                  ...config,
                  simulator:
                    e.target.value === "verilator" ? "verilator" : "icarus",
                })
              }
            >
              <option value="icarus">Icarus</option>
              <option value="verilator" disabled={sdfMode !== "none"}>
                Verilator (RTL only)
              </option>
            </select>
          </label>
          <p className="hint">
            Executable paths and Docker/native execution are configured in
            Toolchain. HDLView does not switch simulators after a failure.
          </p>
          <label>
            Testbench top module
            <input
              data-setting={`simulations.${selected}.top`}
              aria-label="Testbench top module"
              placeholder="tb"
              value={config.top}
              onChange={(e) => change({ ...config, top: e.target.value })}
            />
          </label>
          <label>
            DUT instance path
            <input
              data-setting={`simulations.${selected}.dut_scope`}
              aria-label="DUT instance path"
              placeholder="tb.dut"
              value={config.dut_scope.join(".")}
              onChange={(e) =>
                change({
                  ...config,
                  dut_scope: e.target.value ? e.target.value.split(".") : [],
                })
              }
            />
          </label>
          <p className="hint">
            Enter the full path beginning with the testbench top, for example
            tb.dut when module tb instantiates the design as dut. Names are
            checked by the compiler when you run.
          </p>
          <label>
            Simulation duration
            <div className="duration-fields">
              <input
                data-setting={`simulations.${selected}.stop_time`}
                aria-label="Simulation duration"
                inputMode="numeric"
                value={config.duration}
                onChange={(e) =>
                  change({ ...config, duration: e.target.value })
                }
              />
              <select
                aria-label="Simulation duration unit"
                value={config.unit}
                onChange={(e) => change({ ...config, unit: e.target.value })}
              >
                {["s", "ms", "us", "ns", "ps", "fs"].map((unit) => (
                  <option key={unit} value={unit}>
                    {unit === "us" ? "µs" : unit}
                  </option>
                ))}
                {!["s", "ms", "us", "ns", "ps", "fs"].includes(config.unit) && (
                  <option value={config.unit}>{config.unit}</option>
                )}
              </select>
            </div>
          </label>
          <fieldset
            className="settings-list"
            data-setting={`simulations.${selected}.testbench`}
          >
            <legend>Testbench files</legend>
            {!candidates.length && (
              <p className="hint">
                Add Simulation Sources to make files available here. Headers are
                included through compilation units.
              </p>
            )}
            {candidates.map((file) => (
              <label className="settings-check" key={fileKey(file)}>
                <input
                  type="checkbox"
                  aria-label={`Use testbench ${fileLabel(file)}`}
                  checked={config.testbench.some(
                    (f) => fileKey(f) === fileKey(file),
                  )}
                  onChange={(e) =>
                    change({
                      ...config,
                      testbench: e.target.checked
                        ? [...config.testbench, file]
                        : config.testbench.filter(
                            (f) => fileKey(f) !== fileKey(file),
                          ),
                    })
                  }
                />
                <span>{fileLabel(file)}</span>
              </label>
            ))}
            <p className="hint">
              Selected files compile in the order below. The same configuration
              can run against RTL or gate snapshots.
            </p>
            {config.testbench.map((file, index) => (
              <div className="order-row" key={fileKey(file)}>
                <span>{fileLabel(file)}</span>
                <button
                  aria-label={`Move testbench ${fileLabel(file)} up`}
                  disabled={index === 0}
                  onClick={() =>
                    change({
                      ...config,
                      testbench: move(config.testbench, index, -1),
                    })
                  }
                >
                  ↑
                </button>
                <button
                  aria-label={`Move testbench ${fileLabel(file)} down`}
                  disabled={index === config.testbench.length - 1}
                  onClick={() =>
                    change({
                      ...config,
                      testbench: move(config.testbench, index, 1),
                    })
                  }
                >
                  ↓
                </button>
              </div>
            ))}
          </fieldset>
          <details>
            <summary>Advanced simulation settings</summary>
            <div data-setting={`simulations.${selected}.defines`}>
              <PairEditor
                label="Simulation defines"
                rows={config.defines}
                onChange={(defines) => change({ ...config, defines })}
              />
            </div>
            <ArgumentsEditor
              args={config.args}
              onChange={(args) => change({ ...config, args })}
            />
            <ReferenceEditor
              label="Gate model files"
              files={config.models}
              onChange={(models) => change({ ...config, models })}
              onBrowse={() =>
                onBrowse("model", (files, current) => {
                  const s = current.simulations[selected];
                  return s
                    ? {
                        ...current,
                        simulations: {
                          ...current.simulations,
                          [selected]: { ...s, models: [...s.models, ...files] },
                        },
                      }
                    : current;
                })
              }
            />
            <label>
              SDF source
              <select
                data-setting={`simulations.${selected}.sdf`}
                aria-label="SDF source"
                value={sdfMode}
                onChange={(e) =>
                  change({
                    ...config,
                    use_snapshot_sdf: e.target.value === "snapshot",
                    sdf:
                      e.target.value === "external" ? (config.sdf ?? "") : null,
                  })
                }
              >
                <option value="none">None — functional simulation</option>
                <option value="snapshot">Matching snapshot SDF</option>
                <option value="external">External SDF file</option>
              </select>
            </label>
            {sdfMode === "external" && (
              <label>
                SDF file
                <div className="settings-actions">
                  <input
                    aria-label="SDF file"
                    value={fileLabel(config.sdf ?? "")}
                    onChange={(e) =>
                      change({
                        ...config,
                        sdf: settingsReference(e.target.value),
                      })
                    }
                  />
                  <button
                    onClick={() =>
                      onBrowse("sdf", (files, current) => {
                        const s = current.simulations[selected];
                        return s && files[0]
                          ? {
                              ...current,
                              simulations: {
                                ...current.simulations,
                                [selected]: { ...s, sdf: files[0] },
                              },
                            }
                          : current;
                      })
                    }
                  >
                    Browse SDF…
                  </button>
                </div>
              </label>
            )}
            {sdfMode !== "none" && (
              <>
                <label>
                  Timing corner
                  <input
                    aria-label="Timing corner"
                    list="settings-sdf-corners"
                    value={config.timing_corner ?? ""}
                    onChange={(e) =>
                      change({
                        ...config,
                        timing_corner: e.target.value || null,
                      })
                    }
                  />
                </label>
                <datalist id="settings-sdf-corners">
                  {Object.keys(snapshot?.sdf ?? {}).map((corner) => (
                    <option key={corner} value={corner} />
                  ))}
                </datalist>
                <label>
                  Delay selection
                  <select
                    data-setting={`simulations.${selected}.delay_selection`}
                    aria-label="Delay selection"
                    value={config.delay_selection ?? ""}
                    onChange={(e) =>
                      change({
                        ...config,
                        delay_selection: e.target.value || null,
                      })
                    }
                  >
                    <option value="">
                      Default ({sdfMode === "snapshot" ? "max" : "typ"})
                    </option>
                    <option value="min">min</option>
                    <option value="typ">typ</option>
                    <option value="max">max</option>
                  </select>
                </label>
                <p className="hint">
                  SDF requires Icarus and a matching gate snapshot. Timing
                  corner selects the SDF; delay selection chooses its
                  min/typ/max value. Delay simulation does not provide complete
                  timing-check coverage.
                </p>
              </>
            )}
          </details>
        </>
      )}
    </>
  );
}

export function ProjectSettings({
  controller: c,
  lintPreferences,
  onLintPreferences,
  snapshot,
  onError,
}: {
  controller: ProjectController;
  lintPreferences: LintPreferences;
  onLintPreferences: (preferences: LintPreferences) => void;
  snapshot?: Snapshot;
  onError: (error: unknown) => void;
}) {
  const workspace = c.workspace;
  const [draft, setDraft] = useState(() =>
    workspace ? settingsDraft(workspace.project) : undefined,
  );
  const baseline = useRef(workspace?.project);
  const [editor, setEditor] = useState(lintPreferences);
  const [selected, setSelected] = useState(
    Object.keys(workspace?.project.simulations ?? {})[0] ?? "",
  );
  const [issues, setIssues] = useState<SettingsIssue[]>([]);
  const [warnings, setWarnings] = useState<SettingsIssue[]>([]);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const latest = useRef(draft);
  latest.current = draft;
  const alive = useRef(true);
  const section = c.settingsSection ?? "general";
  const covered = !!c.modal;
  useEffect(() => {
    const previous = document.activeElement;
    alive.current = true;
    return () => {
      alive.current = false;
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  useEffect(() => {
    if (!covered)
      dialog.current
        ?.querySelector<HTMLElement>(
          ".settings-navigation button[aria-current='page']",
        )
        ?.focus();
  }, [covered]);
  useEffect(() => {
    const next = workspace?.project;
    const base = baseline.current;
    if (next && base && next !== base) {
      setDraft((current) =>
        current ? rebaseSettings(current, base, next) : settingsDraft(next),
      );
      baseline.current = next;
    }
  }, [workspace?.project]);
  useEffect(() => {
    if (busy || !issues.length) return;
    const field = issues[0]?.field;
    const target = Array.from(
      dialog.current?.querySelectorAll<HTMLElement>("[data-setting]") ?? [],
    ).find(
      (element) =>
        field === element.dataset.setting ||
        field?.startsWith(`${element.dataset.setting}.`),
    );
    if (target) {
      const details = target.closest("details");
      if (details) details.open = true;
      (target.matches("input, select, textarea")
        ? target
        : target.querySelector<HTMLElement>("input, select, textarea, button")
      )?.focus();
    } else
      dialog.current?.querySelector<HTMLElement>(".settings-errors")?.focus();
  }, [issues, busy]);
  if (!workspace || !draft) return null;
  const change = (value: SettingsDraft) => {
    setDraft(value);
    setIssues([]);
    setWarnings([]);
  };
  const report = (error: unknown) => {
    const issue =
      error instanceof SettingsDraftError
        ? { field: error.field, message: error.message }
        : {
            field: "project",
            message: error instanceof Error ? error.message : String(error),
          };
    setIssues([issue]);
    c.setSettingsSection(issueSection(issue.field));
  };
  const revealIssues = (errors: SettingsIssue[]) => {
    const first = errors[0];
    if (!first) return;
    c.setSettingsSection(issueSection(first.field));
    if (first.field.startsWith("simulations.")) {
      const name = Object.keys(draft.simulations).find((name) =>
        first.field.startsWith(`simulations.${name}.`),
      );
      if (name) setSelected(name);
    }
  };
  const apply = async (close: boolean) => {
    const active = draft;
    setBusy(true);
    try {
      const candidate = settingsProject(active);
      const validation = await projects.validateSettings(
        workspace.path,
        candidate,
      );
      if (!alive.current || latest.current !== active) return;
      setIssues(validation.errors);
      setWarnings(validation.warnings);
      if (validation.errors.length) {
        revealIssues(validation.errors);
        return;
      }
      const updated = await c.update(candidate);
      if (!alive.current) return;
      onLintPreferences(editor);
      baseline.current = updated?.project ?? candidate;
      setDraft(settingsDraft(updated?.project ?? candidate));
      if (close) c.setSettingsSection(undefined);
    } catch (error) {
      if (alive.current) report(error);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const browse = async (
    kind: SettingsInputKind,
    update: (files: FileRef[], current: SettingsDraft) => SettingsDraft,
  ) => {
    const active = draft;
    setBusy(true);
    try {
      const paths = await pick(
        kind === "include_directory"
          ? "directory"
          : kind === "model"
            ? "files"
            : "settings",
        kind === "sdc" ? ["sdc"] : kind === "sdf" ? ["sdf"] : ["v", "sv"],
      );
      if (!paths?.length || !alive.current || latest.current !== active) return;
      const result = await projects.settingsReferences(
        workspace.path,
        settingsProject(active),
        kind,
        paths,
      );
      if (alive.current && latest.current === active)
        change(update(result.references, settingsDraft(result.project)));
    } catch (error) {
      if (alive.current) report(error);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const flow = draft.physical ?? physicalDraft(draft.technology);
  const preset = technologyPreset(draft.technology);
  const technologyChanged = draft.technology !== baseline.current?.technology;
  const currentIssues = issues.filter(
    (issue) => issueSection(issue.field) === section,
  );
  return (
    <div
      className="modal-backdrop settings-backdrop"
      inert={covered}
      aria-hidden={covered || undefined}
    >
      <section
        ref={dialog}
        className="modal settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Project Settings"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            c.setSettingsSection(undefined);
          }
          if (event.key === "Tab") {
            const buttons = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>(
                "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary",
              ),
            ).filter((element) => element.getClientRects().length);
            const first = buttons[0],
              last = buttons.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <div className="modal-title">
          <strong>Project Settings</strong>
          <button
            aria-label="Close project dialog"
            disabled={busy}
            onClick={() => c.setSettingsSection(undefined)}
          >
            ×
          </button>
        </div>
        <div className="settings-body">
          <nav className="settings-navigation" aria-label="Settings sections">
            {settingsSections.map((item) => (
              <button
                key={item.id}
                aria-current={section === item.id ? "page" : undefined}
                onClick={() => c.setSettingsSection(item.id)}
              >
                {item.label}
                {issues.some((issue) => issueSection(issue.field) === item.id)
                  ? " !"
                  : ""}
              </button>
            ))}
          </nav>
          <div className="settings-content">
            <h3>
              {settingsSections.find((item) => item.id === section)?.label}
            </h3>
            {!!currentIssues.length && (
              <div className="settings-errors" role="alert" tabIndex={-1}>
                {currentIssues.map((issue, index) => (
                  <p key={index}>{issue.message}</p>
                ))}
              </div>
            )}
            <fieldset className="settings-fields" disabled={busy}>
              {section === "general" && (
                <>
                  <label>
                    Project name
                    <input
                      data-setting="name"
                      aria-label="Project name"
                      value={draft.name}
                      onChange={(e) =>
                        change({ ...draft, name: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Configuration location
                    <input
                      aria-label="Configuration location"
                      readOnly
                      value={workspace.path}
                    />
                  </label>
                  <label>
                    Design top module
                    <input
                      data-setting="top"
                      aria-label="Design top module"
                      placeholder="counter"
                      value={draft.top}
                      onChange={(e) =>
                        change({ ...draft, top: e.target.value })
                      }
                    />
                  </label>
                  <p className="hint">
                    The module used for schematic compilation. The testbench top
                    is configured separately in Simulation. Empty projects may
                    leave this unset.
                  </p>
                  <label>
                    Language standard
                    <input
                      data-setting="standard"
                      aria-label="Language standard"
                      list="settings-standards"
                      value={draft.standard}
                      onChange={(e) =>
                        change({ ...draft, standard: e.target.value })
                      }
                    />
                  </label>
                  <datalist id="settings-standards">
                    <option value="1800-2017">SystemVerilog 2017</option>
                    <option value="1800-2023">SystemVerilog 2023</option>
                    <option value="1364-2005">Verilog 2005</option>
                  </datalist>
                  <label>
                    Technology
                    <select
                      data-setting="technology"
                      aria-label="Technology"
                      value={draft.technology ?? ""}
                      onChange={(e) => {
                        const technology =
                          e.target.value === "sky130"
                            ? "sky130"
                            : e.target.value === "ihp_sg13g2"
                              ? "ihp_sg13g2"
                              : null;
                        change({
                          ...draft,
                          technology,
                          physical:
                            draft.physical && technology
                              ? {
                                  ...draft.physical,
                                  ...technologyPreset(technology),
                                }
                              : draft.physical,
                        });
                      }}
                    >
                      <option value="">Not selected</option>
                      <option value="sky130">SKY130</option>
                      <option value="ihp_sg13g2">IHP SG13G2</option>
                    </select>
                  </label>
                  {technologyChanged && (
                    <p className="hint">
                      Technology-specific models, SDF corners and LibreLane
                      overrides may need review. Existing artifacts remain
                      unchanged.
                    </p>
                  )}
                </>
              )}
              {section === "sources" && (
                <>
                  <h4>Design compilation order</h4>
                  <div className="compile-order" data-setting="sources">
                    {draft.sources.map((source, index) => (
                      <div key={fileKey(source.path)}>
                        <span>{fileLabel(source.path)}</span>
                        <button
                          aria-label={`Move ${fileLabel(source.path)} up`}
                          disabled={index === 0}
                          onClick={() =>
                            change({
                              ...draft,
                              sources: move(draft.sources, index, -1),
                            })
                          }
                        >
                          ↑
                        </button>
                        <button
                          aria-label={`Move ${fileLabel(source.path)} down`}
                          disabled={index === draft.sources.length - 1}
                          onClick={() =>
                            change({
                              ...draft,
                              sources: move(draft.sources, index, 1),
                            })
                          }
                        >
                          ↓
                        </button>
                      </div>
                    ))}
                  </div>
                  <p className="hint">
                    Put packages before files that use them. Manage source
                    membership through Sources or File → Add New Files.
                  </p>
                  <div data-setting="include_dirs">
                    <ReferenceEditor
                      label="Include directories"
                      files={draft.include_dirs}
                      onChange={(include_dirs) =>
                        change({ ...draft, include_dirs })
                      }
                      onBrowse={() => {
                        void browse("include_directory", (files, current) => ({
                          ...current,
                          include_dirs: [...current.include_dirs, ...files],
                        }));
                      }}
                    />
                  </div>
                  <div data-setting="defines">
                    <PairEditor
                      label="Project defines"
                      rows={draft.defines}
                      onChange={(defines) => change({ ...draft, defines })}
                    />
                  </div>
                  <div data-setting="parameters">
                    <PairEditor
                      label="Design parameters"
                      rows={draft.parameters}
                      onChange={(parameters) =>
                        change({ ...draft, parameters })
                      }
                    />
                  </div>
                </>
              )}
              {section === "simulation" && (
                <SimulationSettings
                  draft={draft}
                  selected={selected}
                  onSelect={setSelected}
                  onChange={change}
                  snapshot={snapshot}
                  onImport={() => {
                    c.setSourceGroup("simulation");
                    c.setModal("add");
                  }}
                  onBrowse={(kind, update) => {
                    void browse(kind, update);
                  }}
                />
              )}
              {section === "physical" && (
                <>
                  <p className="hint">
                    Required for mapped and physical builds. Select technology
                    in General; RTL builds do not need clock settings.
                  </p>
                  <dl className="settings-library">
                    <dt>PDK</dt>
                    <dd>
                      {draft.technology ? preset.pdk : "Select technology"}
                    </dd>
                    <dt>Standard-cell library</dt>
                    <dd>
                      {draft.technology ? preset.library : "Select technology"}
                    </dd>
                  </dl>
                  <label>
                    Clock port (optional)
                    <input
                      data-setting="physical.clock_port"
                      aria-label="Clock port"
                      placeholder="clk"
                      value={flow.clock_port}
                      onChange={(e) =>
                        change({
                          ...draft,
                          physical: { ...flow, clock_port: e.target.value },
                        })
                      }
                    />
                  </label>
                  <p className="hint">
                    Leave the clock port empty for a design without a clock; the
                    period then limits the delay from inputs to outputs.
                  </p>
                  <label>
                    Clock period (ns)
                    <input
                      data-setting="physical.clock_period_ns"
                      aria-label="Clock period (ns)"
                      inputMode="decimal"
                      value={flow.clock_period_ns}
                      onChange={(e) =>
                        change({
                          ...draft,
                          physical: {
                            ...flow,
                            clock_period_ns: e.target.value,
                          },
                        })
                      }
                    />
                  </label>
                  <PairEditor
                    label="Additional clock"
                    setting="physical.additional_clocks"
                    placeholders={["Clock port", "Period (ns)"]}
                    rows={flow.additional_clocks}
                    onChange={(additional_clocks) =>
                      change({
                        ...draft,
                        physical: { ...flow, additional_clocks },
                      })
                    }
                  />
                  {flow.additional_clocks.length > 0 && (
                    <>
                      <label className="settings-check">
                        <input
                          type="checkbox"
                          aria-label="Clocks are related"
                          checked={flow.related_clocks}
                          onChange={(e) =>
                            change({
                              ...draft,
                              physical: {
                                ...flow,
                                related_clocks: e.target.checked,
                              },
                            })
                          }
                        />
                        <span>
                          Clocks are related (time paths between them)
                        </span>
                      </label>
                      <p className="hint">
                        Unless related, the clocks are asynchronous: paths from
                        one clock to another are not timed.
                      </p>
                    </>
                  )}
                  <label>
                    SDC file (optional)
                    <div className="settings-actions">
                      <input
                        aria-label="SDC file"
                        value={flow.sdc ? fileLabel(flow.sdc) : ""}
                        onChange={(e) =>
                          change({
                            ...draft,
                            physical: {
                              ...flow,
                              sdc: e.target.value
                                ? settingsReference(e.target.value)
                                : null,
                            },
                          })
                        }
                      />
                      <button
                        onClick={() => {
                          void browse("sdc", (files, current) => ({
                            ...current,
                            physical: {
                              ...(current.physical ??
                                physicalDraft(current.technology)),
                              sdc: files[0] ?? null,
                            },
                          }));
                        }}
                      >
                        Browse SDC…
                      </button>
                    </div>
                  </label>
                  <label>
                    Core utilization (%)
                    <input
                      data-setting="physical.FP_CORE_UTIL"
                      aria-label="Core utilization (%)"
                      inputMode="decimal"
                      placeholder="30 (flow default)"
                      value={flow.utilization}
                      onChange={(e) =>
                        change({
                          ...draft,
                          physical: { ...flow, utilization: e.target.value },
                        })
                      }
                    />
                  </label>
                  <label>
                    Placement density (%)
                    <input
                      data-setting="physical.PL_TARGET_DENSITY_PCT"
                      aria-label="Placement density (%)"
                      inputMode="decimal"
                      placeholder="40 (flow default)"
                      value={flow.density}
                      onChange={(e) =>
                        change({
                          ...draft,
                          physical: { ...flow, density: e.target.value },
                        })
                      }
                    />
                  </label>
                  <details>
                    <summary>Advanced LibreLane overrides</summary>
                    <p className="hint">
                      Optional JSON for uncommon flow settings. Numeric
                      utilization and density use the controls above; existing
                      expression overrides remain here.
                    </p>
                    <textarea
                      data-setting="physical.overrides"
                      aria-label="LibreLane overrides"
                      rows={12}
                      value={flow.overrides}
                      onChange={(e) =>
                        change({
                          ...draft,
                          physical: { ...flow, overrides: e.target.value },
                        })
                      }
                    />
                  </details>
                </>
              )}
              {section === "editor" && (
                <>
                  <p className="hint">
                    Local to this project on this machine. These preferences are
                    excluded from project JSON and compilation fingerprints.
                  </p>
                  <label className="settings-check">
                    <input
                      type="checkbox"
                      aria-label="Live linting"
                      checked={editor.enabled}
                      onChange={(e) =>
                        setEditor({ ...editor, enabled: e.target.checked })
                      }
                    />
                    <span>Live linting</span>
                  </label>
                  <label className="settings-check">
                    <input
                      type="checkbox"
                      aria-label="Style checks"
                      checked={editor.style}
                      onChange={(e) =>
                        setEditor({ ...editor, style: e.target.checked })
                      }
                    />
                    <span>Style checks</span>
                  </label>
                  <p className="hint">
                    A .rules.verible_lint file beside the configuration replaces
                    the small default style preset.
                  </p>
                </>
              )}
            </fieldset>
            {!!warnings.length && (
              <div className="settings-warnings" aria-label="Project readiness">
                {warnings.map((issue, index) => (
                  <p key={index}>
                    {issue.message}{" "}
                    <button
                      onClick={() =>
                        c.setSettingsSection(issueSection(issue.field))
                      }
                    >
                      Configure{" "}
                      {
                        settingsSections.find(
                          (s) => s.id === issueSection(issue.field),
                        )?.label
                      }
                    </button>
                  </p>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="settings-footer">
          <p className="hint">
            Applied changes are saved with File → Save Project.
          </p>
          <div className="settings-actions">
            <button
              disabled={busy}
              onClick={() => c.setSettingsSection(undefined)}
            >
              Cancel
            </button>
            <button
              disabled={busy}
              onClick={() => {
                void apply(false).catch(onError);
              }}
            >
              Apply
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() => {
                void apply(true).catch(onError);
              }}
            >
              OK
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
