import { SymbolGallery } from "./components/SymbolGallery";
import React, { useCallback, useEffect, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./api";
import { parseProfile } from "./profile";
import { Schematic } from "./components/Schematic";
import { readSchematicPreferences } from "./schematic-display";
import { Waveform } from "./components/Waveform";
import { Workspace, EditorSchematic } from "./components/Workspace";
import {
  nextSelection,
  type Selection,
  type ConnectionTarget,
  formatValue,
  valueBit,
} from "./selection";
import type {
  Snapshot,
  Run,
  Graph,
  Profile,
  Representation,
  Binding,
  WaveInfo,
  Job,
  Node,
  WaveRow,
  Project,
  SettingsValidation,
} from "./types";
import "./style.css";
import { useScopeNavigation } from "./navigation";
import {
  useProjectWorkspace,
  ProjectToolbar,
  ProjectSources,
  ProjectDialogs,
} from "./project-workspace";
import { projects, canSimulate } from "./projects";
import { SourceEditor } from "./components/SourceEditor";
import { EditorProblems } from "./components/EditorProblems";
import { useEditorLint } from "./editor-lint";
import { fileKey } from "./projects";
const defaultProfile: Profile = {
  provider: "docker",
  image: "hdlview-tools:2025.12",
  executables: { librelane: "/usr/local/bin/librelane" },
  plugins: {},
  env: {},
  pdk_root: "/foss/pdks",
  timeout_seconds: 3600,
};
const representations: { id: Representation; label: string }[] = [
  { id: "elaborated", label: "Elaborated RTL" },
  { id: "mapped", label: "Mapped gates" },
  { id: "post_layout", label: "Post-layout" },
];
function App() {
  const generation = useRef(0);
  const flushRef = useRef<() => Promise<void>>(async () => {});
  const flushArtifacts = useCallback(() => flushRef.current(), []);
  const [restoring, setRestoring] = useState(false);
  const [profile, setProfile] = useState<Profile>(() => {
    try {
      const saved = localStorage.getItem("hdlview-profile");
      return saved ? parseProfile(saved) : defaultProfile;
    } catch {
      return defaultProfile;
    }
  });
  const [rep, setRep] = useState<Representation>("elaborated");
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const navigation = useScopeNavigation();
  const { scope, navigate: navigateScope, reset: resetScope } = navigation;
  const [schematicPreferences, setSchematicPreferences] = useState(
    readSchematicPreferences,
  );
  const [details, setDetails] = useState<string[]>([]);
  const detail = details.at(-1);
  const functionalSymbols = schematicPreferences.functional_symbols;
  const showPhysicalCells = schematicPreferences.show_physical_cells;
  function setScope(next: string[]) {
    if (JSON.stringify(next) !== JSON.stringify(scope)) setDetails([]);
    navigateScope(next);
  }
  function openDetail(id: string) {
    setDetails((previous) =>
      previous.at(-1) === id ? previous : [...previous, id],
    );
    setInspect(undefined);
  }
  useEffect(() => {
    localStorage.setItem(
      "hdlview-schematic-display",
      JSON.stringify(schematicPreferences),
    );
  }, [schematicPreferences]);
  const [graph, setGraph] = useState<Graph>();
  const [run, setRun] = useState<Run>();
  const [wave, setWave] = useState<WaveInfo>();
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [visible, setVisible] = useState<number[]>([]);
  const [selection, setSelection] = useState<Selection>();
  const [values, setValues] = useState<Record<number, string>>({});
  const [simulation, setSimulation] = useState("rtl");
  const [job, setJob] = useState<Job>();
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [logs, setLogs] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<"waveforms" | "logs" | "problems">(
    "waveforms",
  );
  const [modal, setModal] = useState<string>();
  const [text, setText] = useState("");
  const [aux, setAux] = useState("");
  const [inspect, setInspect] = useState<Node>();
  const [splitBuses, setSplitBuses] = useState(false);
  const [focus, setFocus] = useState<string>();
  const waveformScope = run
    ? [...run.dut_scope, ...(selection?.scope || scope).slice(1)]
    : [];
  const fail = useCallback((e: unknown) => setError(String(e)), []);
  const [explorer, setExplorer] = useState<"sources" | "design" | "inspector">(
    "sources",
  );
  const [editorCollapsed, setEditorCollapsed] = useState(false);
  const [schematicCollapsed, setSchematicCollapsed] = useState(false);
  const clearWorkspace = useCallback(() => {
    generation.current += 1;
    setRestoring(false);
    setRep("elaborated");
    setEditorCollapsed(false);
    setSchematicCollapsed(false);
    setPanelOpen(false);
    setPanelTab("waveforms");
    setSnapshot(undefined);
    setGraph(undefined);
    setDetails([]);
    setRun(undefined);
    setWave(undefined);
    setBindings([]);
    setVisible([]);
    setValues({});
    setSelection(undefined);
    setInspect(undefined);
    setFocus(undefined);
    setJob(undefined);
    setError("");
    setExplorer("sources");
  }, []);
  const working = useProjectWorkspace(
    clearWorkspace,
    fail,
    flushArtifacts,
    restoring || job?.status === "running",
    () => {
      setEditorCollapsed(false);
      setExplorer("sources");
    },
  );
  const markBuilt = working.markBuilt;
  const project = working.workspace?.project;
  const path = working.workspace?.path ?? "";
  const lint = useEditorLint(
    working.workspace,
    working.tabs,
    working.activeTab,
    profile,
    simulation,
    restoring ||
      job?.status === "running" ||
      working.job?.status === "running" ||
      working.fileBusy ||
      !!working.fileDialog ||
      !!working.modal ||
      !!working.settingsSection,
  );
  const activeFile = working.activeTab?.readonly
    ? undefined
    : working.activeTab?.document?.file;
  const editorDiagnostics = (lint.result?.diagnostics ?? []).filter(
    (d) => activeFile && d.file && fileKey(d.file) === fileKey(activeFile),
  );
  const workspaceEpoch = generation.current;
  const configuredSimulations =
    project?.simulations ?? snapshot?.project.simulations;
  const [checkedSettings, setCheckedSettings] = useState<{
    project: Project;
    snapshotId?: string;
    result: SettingsValidation;
  }>();
  const snapshotId = snapshot?.id;
  useEffect(() => {
    if (!project) return;
    let active = true;
    projects
      .validateSettings(path, project, snapshotId)
      .then((result) => {
        if (active) setCheckedSettings({ project, snapshotId, result });
      })
      .catch((error: unknown) => {
        if (active) fail(error);
      });
    return () => {
      active = false;
    };
  }, [path, project, snapshotId, fail]);
  const settingsValidation =
    checkedSettings &&
    checkedSettings.project === project &&
    checkedSettings?.snapshotId === snapshotId
      ? checkedSettings.result
      : undefined;
  const pendingSettings =
    !!project && !!snapshot && settingsValidation?.matches_snapshot === false;
  const simulationSettingsReady =
    !project || settingsValidation?.matches_snapshot === true;
  const simulations = configuredSimulations;
  const availableSimulations = Object.entries(simulations ?? {}).filter(
    ([, config]) =>
      canSimulate(config, snapshot) && config.testbench.length > 0,
  );
  useEffect(() => {
    const names = Object.entries(configuredSimulations ?? {})
      .filter(([, config]) => canSimulate(config, snapshot))
      .map(([name]) => name);
    if (!names.includes(simulation)) setSimulation(names[0] ?? "");
  }, [configuredSimulations, snapshot, simulation]);
  const viewSource = (source: string) => {
    if (snapshot)
      void working
        .openSnapshotSource(snapshot.id, source)
        .then(() => setEditorCollapsed(false))
        .catch(fail);
  };
  const acceptSnapshot = useCallback(
    (s: Snapshot) => {
      setSnapshot(s);
      setExplorer("design");
      setGraph(undefined);
      setRep(s.representation);
      resetScope([s.project.top]);
      setDetails([]);
      setRun(undefined);
      setWave(undefined);
      setBindings([]);
      setVisible([]);
      setSelection(undefined);
      setFocus(undefined);
      setInspect(undefined);
    },
    [resetScope],
  );
  const acceptRun = useCallback(async (r: Run) => {
    const current = generation.current;
    const [info, binding] = await Promise.all([
      api<WaveInfo>("wave_info", { run_id: r.id }),
      api<Binding[]>("bindings", { run_id: r.id }),
    ]);
    if (current !== generation.current) return;
    setRun(r);
    setWave(info);
    setPanelTab("waveforms");
    setPanelOpen(true);
    setBindings(binding);
    setVisible(
      info.variables
        .filter(
          (v) =>
            v.path.length === r.dut_scope.length + 1 &&
            r.dut_scope.every((x, i) => v.path[i] === x),
        )
        .slice(0, 12)
        .map((v) => v.id),
    );
  }, []);
  useEffect(() => {
    if (!snapshot || !scope.length) return;
    let active = true;
    api<Graph>("view", {
      snapshot_id: snapshot.id,
      scope,
      focus,
      split_buses: splitBuses,
      options: {
        functional_symbols: functionalSymbols,
        show_physical_cells: showPhysicalCells,
        detail,
      },
    })
      .then((g) => {
        if (active) setGraph(g);
      })
      .catch((e) => {
        if (active) fail(e);
      });
    return () => {
      active = false;
    };
  }, [
    snapshot,
    scope,
    focus,
    splitBuses,
    functionalSymbols,
    showPhysicalCells,
    detail,
    fail,
  ]);
  useEffect(() => {
    if (!job || job.status !== "running") return;
    let active = true;
    const pollingGeneration = generation.current;
    const id = setInterval(() => {
      api<Job>("job", { id: job.id })
        .then(async (j) => {
          if (!active) return;
          const current = generation.current;
          setJob(j);
          if (j.status === "cancelled") setRestoring(false);
          if (j.status === "failed") {
            fail(j.error);
            setRestoring(false);
          }
          if (j.status === "complete") {
            if (j.kind === "build") {
              acceptSnapshot(j.result as Snapshot);
              markBuilt();
            } else if (["simulate", "import", "open_run"].includes(j.kind)) {
              await acceptRun(j.result as Run);
              if (current === generation.current) setRestoring(false);
            } else if (j.kind === "probe") {
              setText(JSON.stringify(j.result, null, 2));
              setModal("Probe results");
            }
          }
        })
        .catch((e) => {
          if (pollingGeneration === generation.current) {
            fail(e);
            setRestoring(false);
          }
        });
      if (panelOpen && panelTab === "logs")
        api<string>("logs").then(setLogs).catch(fail);
    }, 500);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [job, panelOpen, panelTab, acceptSnapshot, acceptRun, fail, markBuilt]);
  const checkpoint = useCallback(async () => {
    if (!path || !snapshot || snapshot.project_path !== path || restoring)
      return;
    await projects.checkpoint(
      path,
      snapshot.directory + "/snapshot.json",
      run ? run.directory + "/run.json" : undefined,
    );
  }, [path, snapshot, run, restoring]);
  useEffect(() => {
    flushRef.current = checkpoint;
  }, [checkpoint]);
  useEffect(() => {
    void checkpoint().catch(fail);
  }, [checkpoint, fail]);
  const markStale = working.markStale;
  useEffect(() => {
    if (!path) return;
    let active = true;
    setRestoring(true);
    projects
      .restore(path)
      .then(async (state) => {
        if (!active) return;
        if (state.warnings.length) setError(state.warnings.join("\n"));
        if (state.snapshot) {
          acceptSnapshot(state.snapshot);
          setExplorer("sources");
          if (state.stale) markStale();
          if (state.run_path) {
            const result = await api<Job>("open_run", {
              path: state.run_path,
              snapshot_id: state.snapshot.id,
            });
            if (active) setJob(result);
            return;
          }
        }
        setRestoring(false);
      })
      .catch((e) => {
        if (active) {
          setRestoring(false);
          fail(e);
        }
      });
    return () => {
      active = false;
    };
  }, [path, workspaceEpoch, acceptSnapshot, markStale, fail]);
  async function startBuild() {
    setError("");
    try {
      if (
        ["mapped", "post_layout"].includes(rep) &&
        !project?.physical?.clock_period_ns
      ) {
        working.setSettingsSection("physical");
        throw new Error(
          "Set technology and clock period in Project Settings before a mapped or physical build.",
        );
      }
      if (!(await working.beforeBuild())) return;
      working.markBuildStarted();

      setJob(await api<Job>("build", { path, profile, representation: rep }));
    } catch (e) {
      fail(e);
    }
  }
  async function startSimulation() {
    if (!snapshot) return;
    if (!simulationSettingsReady) {
      fail("Rebuild the schematic to use updated project settings.");
      return;
    }
    setError("");
    try {
      setJob(
        await api<Job>("simulate", {
          snapshot_id: snapshot.id,
          name: simulation,
          project_path: project ? path : undefined,
        }),
      );
    } catch (e) {
      fail(e);
    }
  }
  function pickSignal(
    ids: string[],
    connection?: ConnectionTarget,
    origin: Selection["origin"] = "schematic",
  ) {
    // The graph supplies the clicked declaration/endpoint first. A missing pin
    // must never fall through to an electrically connected but delayed net.
    const id = ids[0];
    if (!id && !connection) return;
    setInspect(
      connection?.kind === "pin"
        ? graph?.nodes.find((n) => n.id === connection.nodeId)
        : undefined,
    );
    const binding = bindings.find((b) => b.signal_id === id);
    const variableId =
      binding && ["exact", "manual"].includes(binding.status)
        ? binding.variable_ids[0]
        : undefined;
    setSelection((p) =>
      nextSelection(p, {
        origin,
        signalId: id,
        variableId,
        connection,
      }),
    );
    if (variableId !== undefined)
      setVisible((v) => (v.includes(variableId) ? v : [...v, variableId]));
  }
  function pickWave(id: number) {
    const candidates = bindings.filter(
      (b) =>
        b.variable_ids.includes(id) && ["exact", "manual"].includes(b.status),
    );
    const match =
      candidates.find((b) =>
        graph?.signals.some((s) => s.id === b.signal_id),
      ) || candidates[0];
    setSelection((p) =>
      nextSelection(p, {
        origin: "waveform",
        variableId: id,
        signalId: match?.signal_id,
      }),
    );
    if (match && snapshot) {
      const marker = ":signal:";
      const segments = JSON.parse(
        match.signal_id.slice(match.signal_id.indexOf(marker) + marker.length),
      ) as string[];
      setFocus(undefined);
      const hidden = graph?.nodes.find((node) =>
        node.display.internal_signal_ids.includes(match.signal_id),
      );
      if (hidden?.display.detail) openDetail(hidden.display.detail);
      const parent = segments.slice(0, -1);
      setScope(
        snapshot.design.scopes
          .map((s) => s.path)
          .filter((p) => p.every((part, i) => parent[i] === part))
          .sort((a, b) => b.length - a.length)[0] || [snapshot.project.top],
      );
    }
  }
  async function cursor(time: string) {
    if (!run) return;
    const ids = [
      ...new Set(
        (graph?.signals || []).flatMap(
          (s) =>
            bindings.find(
              (b) =>
                b.signal_id === s.id && ["exact", "manual"].includes(b.status),
            )?.variable_ids || [],
        ),
      ),
    ].slice(0, 200);
    try {
      const rows = await api<WaveRow[]>("wave_values", {
        run_id: run.id,
        ids,
        start: time,
      });
      setValues(
        Object.fromEntries(
          rows.map((r) => [r.id, r.transitions.at(-1)?.value || "unavailable"]),
        ),
      );
    } catch (e) {
      fail(e);
    }
  }
  const pinTarget = selection?.connection;
  const pinOwner =
    pinTarget?.kind === "pin"
      ? graph?.nodes.find((node) => node.id === pinTarget.nodeId)
      : undefined;
  const inspectedPin =
    pinTarget?.kind === "pin"
      ? pinOwner?.ports.find((port) => port.id === pinTarget.portId)
      : undefined;
  const selectedSignal = graph?.signals.find(
    (s) => s.id === selection?.signalId,
  );
  const selectedBinding = bindings.find(
    (b) => b.signal_id === selection?.signalId,
  );
  const busy = restoring || job?.status === "running" || working.fileBusy;
  async function submitModal() {
    try {
      if (modal === "Toolchain") {
        setProfile(parseProfile(text));
        localStorage.setItem("hdlview-profile", text);
        setModal(undefined);
      } else if (modal === "Open snapshot") {
        acceptSnapshot(await api<Snapshot>("open_snapshot", { path: text }));
        setModal(undefined);
      } else if (modal === "Import waveform" && snapshot) {
        const dutScope: unknown = JSON.parse(aux);
        setJob(
          await api<Job>("import_trace", {
            snapshot_id: snapshot.id,
            path: text,
            dut_scope: dutScope,
          }),
        );
        setModal(undefined);
      } else if (modal === "Manual binding" && run && selection?.signalId) {
        if (text === "") throw new Error("Choose a waveform declaration");
        setBindings(
          await api<Binding[]>("map_signal", {
            run_id: run.id,
            signal_id: selection.signalId,
            variable_id: Number(text),
          }),
        );
        setModal(undefined);
      }
    } catch (e) {
      fail(e);
    }
  }
  return (
    <>
      <header inert={!!working.settingsSection}>
        <ProjectToolbar
          controller={working}
          busy={busy || working.job?.status === "running"}
          onError={fail}
        />
        <button
          onClick={() => {
            setText(JSON.stringify(profile, null, 2));
            setModal("Toolchain");
          }}
        >
          Toolchain
        </button>
        <span className="project-title" title={path}>
          {project?.name ?? "No project open"}
          {working.dirtyProject ? " *" : ""}
        </span>
        <div className="brand">
          <span className="brand-icon">H</span>
          <strong>
            HDL<span>View</span>
          </strong>
        </div>
      </header>
      <nav className="workflow" inert={!!working.settingsSection}>
        <div className="stages">
          {representations.map((r) => (
            <button
              key={r.id}
              className={rep === r.id ? "active" : ""}
              disabled={!!run || busy}
              onClick={() => setRep(r.id)}
            >
              {r.label}
            </button>
          ))}
        </div>
        <button
          className="primary"
          disabled={
            !project ||
            !project.top ||
            !project.sources.length ||
            busy ||
            working.job?.status === "running" ||
            !!run
          }
          onClick={() => {
            void startBuild();
          }}
        >
          Build schematic
        </button>
        {!Object.keys(simulations ?? {}).length && project ? (
          <button
            disabled={busy || working.job?.status === "running"}
            onClick={() => working.setSettingsSection("simulation")}
          >
            Configure Simulation…
          </button>
        ) : (
          <select
            aria-label="Simulation configuration"
            value={simulation}
            onChange={(e) => setSimulation(e.target.value)}
          >
            {Object.keys(simulations ?? {}).map((n) => (
              <option
                key={n}
                disabled={!availableSimulations.some(([name]) => name === n)}
              >
                {n}
              </option>
            ))}
          </select>
        )}
        <button
          disabled={
            !snapshot ||
            !simulationSettingsReady ||
            busy ||
            !availableSimulations.some(([name]) => name === simulation)
          }
          onClick={() => {
            void startSimulation();
          }}
        >
          ▶ Run simulation
        </button>
        {run && (
          <button
            onClick={() => {
              api("close_run", { run_id: run.id }).catch(fail);
              setRun(undefined);
              setWave(undefined);
              setBindings([]);
              setVisible([]);
              setValues({});
            }}
          >
            Close waveform session
          </button>
        )}
      </nav>
      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button onClick={() => setError("")}>Dismiss</button>
        </div>
      )}
      <Workspace
        key={path}
        inert={!!working.settingsSection}
        panelOpen={panelOpen}
        sidebar={
          <aside className="sidebar">
            <div className="explorer-tabs" aria-label="Project views">
              <button
                aria-pressed={explorer === "sources"}
                className={explorer === "sources" ? "active" : ""}
                onClick={() => setExplorer("sources")}
              >
                Sources
              </button>
              <button
                aria-pressed={explorer === "design"}
                className={explorer === "design" ? "active" : ""}
                onClick={() => setExplorer("design")}
              >
                Design
              </button>
              <button
                aria-pressed={explorer === "inspector"}
                className={explorer === "inspector" ? "active" : ""}
                onClick={() => setExplorer("inspector")}
              >
                Inspector
              </button>
            </div>
            <div className="sidebar-content" hidden={explorer !== "sources"}>
              <ProjectSources
                controller={working}
                onOpen={(file) => {
                  setEditorCollapsed(false);
                  void working.openFile(file).catch(fail);
                }}
                busy={busy || working.job?.status === "running"}
                onError={fail}
              />
            </div>
            <div className="sidebar-content" hidden={explorer !== "inspector"}>
              <section className="inspector" aria-label="Project inspector">
                <div className="panel-heading">INSPECTOR</div>
                {inspectedPin && (
                  <p className="pin-inspection">
                    Pin {inspectedPin.display.name || inspectedPin.label} ·{" "}
                    {pinOwner?.label} ·{" "}
                    {inspectedPin.display.declared_direction ??
                      inspectedPin.direction}
                  </p>
                )}
                {selectedSignal ? (
                  <>
                    <p className="selection-kind">
                      {selection?.connection?.kind === "pin"
                        ? "Pin"
                        : "Signal / wire"}
                    </p>
                    <h3>{selectedSignal.path.at(-1)}</h3>
                    <p className="path">{selectedSignal.path.join(".")}</p>
                    <dl>
                      <dt>Width</dt>
                      <dd>{selectedSignal.width} bits</dd>
                      <dt>Waveform</dt>
                      <dd>{selectedBinding?.status || "No trace loaded"}</dd>
                    </dl>
                    <p className="hint">{selectedBinding?.evidence}</p>
                    <button onClick={() => setFocus(selectedSignal.id)}>
                      Explore connected cells
                    </button>
                    {run && (
                      <button
                        onClick={() => {
                          setText("");
                          setModal("Manual binding");
                        }}
                      >
                        Map waveform signal
                      </button>
                    )}
                    {selectedSignal.source && (
                      <button
                        onClick={() => {
                          if (selectedSignal.source)
                            viewSource(selectedSignal.source);
                        }}
                      >
                        View source
                      </button>
                    )}
                  </>
                ) : (
                  <p className="hint">
                    {inspectedPin
                      ? "No waveform declaration for this pin."
                      : "Select a signal, wire, or cell to inspect it."}
                  </p>
                )}
                {inspect && (
                  <>
                    <h3>{inspect.label}</h3>
                    <p>{inspect.kind}</p>
                    {inspect.display.annotations.map((annotation) => (
                      <p className="hint" key={annotation}>
                        {annotation}
                      </p>
                    ))}
                    {inspect.display.detail && (
                      <button
                        onClick={() => openDetail(inspect.display.detail ?? "")}
                      >
                        Inspect original structure
                      </button>
                    )}
                    {inspect.display.members.length ? (
                      <details>
                        <summary>Grouped compiler nodes</summary>
                        <ul>
                          {inspect.display.members.map((id) => (
                            <li key={id}>{id}</li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                    {inspect.child_scope && (
                      <button
                        onClick={() => {
                          if (inspect.child_scope)
                            setScope(inspect.child_scope);
                        }}
                      >
                        Enter instance
                      </button>
                    )}
                    <div className="pin-list">
                      {inspect.ports
                        .filter((p) => p.display.role !== "power")
                        .map((p) => (
                          <button
                            key={p.id}
                            onClick={() =>
                              pickSignal(p.signal_ids, {
                                kind: "pin",
                                nodeId: inspect.id,
                                portId: p.id,
                              })
                            }
                          >
                            {p.direction === "output" ? "→" : "←"} {p.label}
                          </button>
                        ))}
                    </div>
                    {inspect.ports.some((p) => p.display.role === "power") && (
                      <details>
                        <summary>Power connections</summary>
                        <div className="pin-list">
                          {inspect.ports
                            .filter((p) => p.display.role === "power")
                            .map((p) => (
                              <button
                                key={p.id}
                                onClick={() =>
                                  pickSignal(p.signal_ids, {
                                    kind: "pin",
                                    nodeId: inspect.id,
                                    portId: p.id,
                                  })
                                }
                              >
                                {p.label}
                              </button>
                            ))}
                        </div>
                      </details>
                    )}
                    {inspect.source && (
                      <button
                        onClick={() => {
                          if (inspect.source) viewSource(inspect.source);
                        }}
                      >
                        View source
                      </button>
                    )}
                    <details>
                      <summary>Cell details</summary>
                      <pre>
                        {JSON.stringify(
                          snapshot?.design.modules[
                            snapshot.design.scopes.find(
                              (s) =>
                                JSON.stringify(s.path) ===
                                JSON.stringify(scope),
                            )?.module || ""
                          ]?.cells.find((c) => c.name === inspect.label)
                            ?.attributes,
                          null,
                          2,
                        )}
                      </pre>
                    </details>
                  </>
                )}
                {snapshot?.physical_run && (
                  <details>
                    <summary>
                      Physical results: {snapshot.physical_run.status}
                    </summary>
                    <pre>
                      {JSON.stringify(
                        snapshot.physical_run.state.metrics,
                        null,
                        2,
                      )}
                    </pre>
                    {snapshot.physical_run.reports.map((p) => (
                      <button
                        className="path"
                        key={p}
                        onClick={() =>
                          void api<string>("report", {
                            snapshot_id: snapshot.id,
                            path: p,
                          })
                            .then((content) => {
                              setText(content);
                              setModal("Report");
                            })
                            .catch(fail)
                        }
                      >
                        {p.split("/").slice(-2).join("/")}
                      </button>
                    ))}
                  </details>
                )}
                <div className="diagnostics">
                  {[
                    ...(snapshot?.diagnostics || []),
                    ...(run?.diagnostics || []),
                  ].map((d, i) => (
                    <p key={i} className={d.severity}>
                      {d.message}
                    </p>
                  ))}
                </div>
              </section>
            </div>
            <div className="sidebar-content" hidden={explorer !== "design"}>
              <div className="panel-heading">
                DESIGN HIERARCHY{" "}
                <span>{snapshot?.design.scopes.length || 0}</span>
              </div>
              {snapshot ? (
                <>
                  <div className="project-name">
                    {snapshot.project.name}
                    <small>
                      {snapshot.id.slice(0, 12)} ·{" "}
                      {
                        representations.find(
                          (r) => r.id === snapshot.representation,
                        )?.label
                      }
                    </small>
                  </div>
                  <div className="hierarchy">
                    {snapshot.design.scopes
                      .filter(
                        (s) =>
                          s.path.length === 1 ||
                          s.path.slice(0, -1).every((p, i) => scope[i] === p),
                      )
                      .slice(0, 1000)
                      .map((s) => (
                        <button
                          key={JSON.stringify(s.path)}
                          style={{
                            paddingLeft: 12 + (s.path.length - 1) * 16,
                          }}
                          className={
                            JSON.stringify(scope) === JSON.stringify(s.path)
                              ? "active"
                              : ""
                          }
                          onClick={() => {
                            setScope(s.path);
                            setFocus(undefined);
                            setSelection((p) =>
                              nextSelection(p, {
                                origin: "hierarchy",
                                scope: s.path,
                              }),
                            );
                          }}
                        >
                          <span>◇</span> {s.path.at(-1)}
                        </button>
                      ))}
                  </div>
                </>
              ) : (
                <p className="hint">
                  Open a project and build a schematic to explore its hierarchy.
                </p>
              )}
              <div className="panel-heading">
                SIGNALS <span>{graph?.signals.length || 0}</span>
              </div>
              <input
                className="search"
                aria-label="Search signals"
                placeholder="Search signals…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <div className="signal-list">
                {graph?.signals
                  .filter((s) =>
                    s.path.at(-1)!.toLowerCase().includes(search.toLowerCase()),
                  )
                  .slice(0, 1000)
                  .map((s) => {
                    const b = bindings.find((b) => b.signal_id === s.id);
                    const variableId = b?.variable_ids[0];
                    return (
                      <button
                        key={s.id}
                        className={selection?.signalId === s.id ? "active" : ""}
                        onClick={() =>
                          pickSignal([s.id], undefined, "hierarchy")
                        }
                      >
                        <span>
                          {s.path.at(-1)}
                          {s.width > 1 ? <small> /{s.width}</small> : null}
                        </span>
                        <small
                          className={
                            b?.status === "missing" ? "unavailable" : ""
                          }
                        >
                          {variableId !== undefined
                            ? formatValue(
                                valueBit(
                                  values[variableId] ?? "",
                                  b?.variable_bit,
                                ),
                                "hex",
                              )
                            : run
                              ? "—"
                              : ""}
                        </small>
                      </button>
                    );
                  })}
              </div>
              {run && wave && (
                <details className="wave-browser">
                  <summary>Waveform scopes & signals</summary>
                  <p className="path" aria-label="Selected waveform scope">
                    {waveformScope.join(".")}
                  </p>
                  <button
                    onClick={() => {
                      const prefix = waveformScope;
                      setVisible((v) => [
                        ...new Set([
                          ...v,
                          ...wave.variables
                            .filter((x) =>
                              prefix.every((p, i) => x.path[i] === p),
                            )
                            .slice(0, 200)
                            .map((x) => x.id),
                        ]),
                      ]);
                    }}
                  >
                    Add signals in selected scope
                  </button>
                  {wave.variables
                    .filter((v) =>
                      v.path
                        .join(".")
                        .toLowerCase()
                        .includes(search.toLowerCase()),
                    )
                    .slice(0, 300)
                    .map((v) => (
                      <button
                        key={v.id}
                        onClick={() => {
                          setVisible((ids) =>
                            ids.includes(v.id) ? ids : [...ids, v.id],
                          );
                          pickWave(v.id);
                        }}
                      >
                        {v.path.join(".")}
                      </button>
                    ))}
                </details>
              )}
            </div>
          </aside>
        }
        panel={
          <section className="bottom-panel" aria-label="Bottom panel">
            <div className="panel-tabs">
              <div
                role="tablist"
                aria-label="Panel views"
                onKeyDown={(event) => {
                  if (
                    !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                      event.key,
                    )
                  )
                    return;
                  event.preventDefault();
                  const tabs = Array.from(
                    event.currentTarget.querySelectorAll<HTMLButtonElement>(
                      '[role="tab"]',
                    ),
                  );
                  const current = tabs.findIndex((tab) => tab === event.target);
                  const index =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? tabs.length - 1
                        : (current +
                            (event.key === "ArrowRight"
                              ? 1
                              : tabs.length - 1)) %
                          tabs.length;
                  tabs[index]?.focus();
                  tabs[index]?.click();
                }}
              >
                {(["waveforms", "logs", "problems"] as const).map((tab) => (
                  <button
                    key={tab}
                    id={`panel-tab-${tab}`}
                    role="tab"
                    aria-selected={panelTab === tab}
                    aria-controls={`panel-${tab}`}
                    tabIndex={panelTab === tab ? 0 : -1}
                    className={panelTab === tab ? "active" : ""}
                    onClick={() => {
                      setPanelTab(tab);
                      setPanelOpen(true);
                      if (tab === "logs")
                        api<string>("logs").then(setLogs).catch(fail);
                    }}
                  >
                    {tab === "waveforms"
                      ? "Waveforms"
                      : tab === "logs"
                        ? "Logs"
                        : `Problems ${lint.result?.diagnostics.length ?? 0}`}
                  </button>
                ))}
              </div>
              <button
                aria-label={
                  panelOpen ? "Hide bottom panel" : "Show bottom panel"
                }
                aria-expanded={panelOpen}
                onClick={() => setPanelOpen(!panelOpen)}
              >
                {panelOpen ? "⌄" : "⌃"}
              </button>
            </div>
            <div className="bottom-content" hidden={!panelOpen}>
              <div
                id="panel-waveforms"
                role="tabpanel"
                aria-labelledby="panel-tab-waveforms"
                hidden={panelTab !== "waveforms"}
              >
                {run && wave ? (
                  <Waveform
                    key={run.id}
                    active={panelOpen && panelTab === "waveforms"}
                    run={run}
                    info={wave}
                    visible={visible}
                    selected={selection?.variableId}
                    onSelect={pickWave}
                    onVisible={setVisible}
                    onCursor={(time) => {
                      void cursor(time);
                    }}
                  />
                ) : (
                  <div className="wave-empty">
                    <strong>Waveform workspace</strong>
                    <span>Run a simulation or import a matching trace.</span>
                    <button
                      disabled={!snapshot || busy}
                      onClick={() => {
                        setText("");
                        setAux(
                          JSON.stringify([
                            project?.simulations && simulation ? "tb" : "tb",
                            "dut",
                          ]),
                        );
                        setModal("Import waveform");
                      }}
                    >
                      Import VCD / FST
                    </button>
                  </div>
                )}
              </div>
              <div
                id="panel-logs"
                role="tabpanel"
                aria-labelledby="panel-tab-logs"
                hidden={panelTab !== "logs"}
              >
                <section className="log-drawer" aria-label="Tool logs">
                  <pre>{logs || "Tool logs will appear here."}</pre>
                </section>
              </div>
              <div
                id="panel-problems"
                role="tabpanel"
                aria-labelledby="panel-tab-problems"
                hidden={panelTab !== "problems"}
              >
                <section className="log-drawer" aria-label="Problems panel">
                  <EditorProblems
                    result={lint.result}
                    error={lint.error}
                    status={lint.status}
                    onConfigure={
                      lint.context?.context.kind === "simulation" &&
                      !lint.context.context.configuration
                        ? () => working.setSettingsSection("simulation")
                        : undefined
                    }
                    onNavigate={(location) => {
                      if (
                        location.file &&
                        location.from !== undefined &&
                        location.to !== undefined
                      )
                        void working
                          .openFile(location.file, {
                            from: location.from,
                            to: location.to,
                          })
                          .catch(fail);
                    }}
                  />
                </section>
              </div>
            </div>
          </section>
        }
      >
        <div className="workspace-tools">
          <button onClick={() => setEditorCollapsed(!editorCollapsed)}>
            {editorCollapsed ? "Show Editor" : "Hide Editor"}
          </button>
          <button onClick={() => setSchematicCollapsed(!schematicCollapsed)}>
            {schematicCollapsed ? "Show Schematic" : "Hide Schematic"}
          </button>
          {working.stale && snapshot && (
            <span>
              {pendingSettings
                ? "Rebuild required to use updated settings"
                : "Sources changed · rebuild needed"}
            </span>
          )}
          {project && (!project.top || !project.sources.length) && (
            <span className="workflow-guidance">
              {!project.top
                ? "Set the design top before building."
                : "Add design sources before building."}{" "}
              <button
                onClick={() =>
                  working.setSettingsSection(
                    !project.top ? "general" : "sources",
                  )
                }
              >
                Configure Project…
              </button>
            </span>
          )}
          {project &&
            ["mapped", "post_layout"].includes(rep) &&
            !project.physical && (
              <span className="workflow-guidance">
                Clock settings are required.{" "}
                <button onClick={() => working.setSettingsSection("physical")}>
                  Configure Physical Design…
                </button>
              </span>
            )}
          {project &&
            simulation &&
            simulations?.[simulation] &&
            !simulations[simulation].testbench.length && (
              <span className="workflow-guidance">
                Select testbench files before simulation.{" "}
                <button
                  onClick={() => working.setSettingsSection("simulation")}
                >
                  Configure Simulation…
                </button>
              </span>
            )}
        </div>
        <EditorSchematic
          editorCollapsed={editorCollapsed}
          schematicCollapsed={schematicCollapsed}
          editor={
            working.activeTab && (
              <div
                className="editor-pane"
                style={{ display: editorCollapsed ? "none" : undefined }}
              >
                <div className="editor-tabs">
                  {working.tabs.map((tab) => (
                    <div
                      key={tab.id}
                      className={working.active === tab.id ? "active" : ""}
                    >
                      <button
                        title={tab.label}
                        onClick={() => working.setActive(tab.id)}
                      >
                        {tab.label}
                        {tab.text !== tab.saved ? " *" : ""}
                      </button>
                      <button
                        aria-label={`Close ${tab.label}`}
                        onClick={() => void working.closeTab(tab).catch(fail)}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
                <div className="editor-tools">
                  {working.activeTab.readonly ? (
                    <>
                      <span>Captured source · read-only</span>
                      <button
                        disabled={!project}
                        onClick={() => {
                          const tab = working.activeTab;
                          if (tab)
                            void working.openWorkingFile(tab).catch(fail);
                        }}
                      >
                        Open Working File
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => {
                        const tab = working.activeTab;
                        if (tab) void working.saveTab(tab).catch(fail);
                      }}
                    >
                      Save
                    </button>
                  )}
                </div>
                {!!lint.status && (
                  <div className="lint-status" aria-label="Editor lint status">
                    <span>{lint.status}</span>
                    {lint.context &&
                      lint.context.choices.length > 1 &&
                      lint.context.context.kind === "simulation" && (
                        <label>
                          Analysis context{" "}
                          <select
                            aria-label="Lint simulation configuration"
                            value={lint.context.context.configuration ?? ""}
                            onChange={(event) =>
                              lint.setContext(event.target.value)
                            }
                          >
                            <option value="">Syntax and style only</option>
                            {lint.context.choices.map((name) => (
                              <option key={name} value={name}>
                                {name}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                    {lint.context?.context.kind === "simulation" &&
                      lint.context.choices.length === 1 && (
                        <span>
                          Simulation: {lint.context.context.configuration}
                        </span>
                      )}
                  </div>
                )}
                <SourceEditor
                  tab={working.activeTab}
                  tabIds={working.tabs.map((t) => t.id)}
                  onChange={working.updateTab}
                  diagnostics={editorDiagnostics}
                />
              </div>
            )
          }
          schematic={
            <div className="design-pane" hidden={schematicCollapsed}>
              <div className="breadcrumbs">
                <button
                  aria-label="Previous scope"
                  disabled={!navigation.canBack}
                  onClick={() => {
                    setDetails([]);
                    navigation.back();
                  }}
                >
                  ←
                </button>
                <button
                  aria-label="Next scope"
                  disabled={!navigation.canForward}
                  onClick={() => {
                    setDetails([]);
                    navigation.forward();
                  }}
                >
                  →
                </button>
                {scope.map((s, i) => (
                  <React.Fragment key={i}>
                    <button
                      onClick={() => {
                        setScope(scope.slice(0, i + 1));
                        setFocus(undefined);
                      }}
                    >
                      {s}
                    </button>
                    <span>/</span>
                  </React.Fragment>
                ))}
                {detail && (
                  <>
                    <button
                      onClick={() =>
                        setDetails((previous) => previous.slice(0, -1))
                      }
                    >
                      Back to parent schematic
                    </button>
                    <span>Details</span>
                  </>
                )}
                {focus && (
                  <button onClick={() => setFocus(undefined)}>
                    Clear cone focus
                  </button>
                )}
                <span className="snapshot-note">
                  {run
                    ? "Bound to simulation " + run.id.slice(0, 8)
                    : "Schematic exploration"}
                </span>
              </div>
              {graph ? (
                <Schematic
                  graph={graph}
                  preferences={schematicPreferences}
                  onPreferences={setSchematicPreferences}
                  onDetail={openDetail}
                  splitBuses={splitBuses}
                  onSplitBuses={() => setSplitBuses(!splitBuses)}
                  selected={selection?.signalId}
                  reveal={
                    selection?.origin === "schematic"
                      ? undefined
                      : selection?.sequence
                  }
                  target={selection?.connection}
                  inspected={inspect?.id}
                  onSignal={pickSignal}
                  onScope={(s) => {
                    setScope(s);
                    setFocus(undefined);
                  }}
                  onInspect={(node) => {
                    setInspect(node);
                    setSelection((previous) =>
                      nextSelection(previous, {
                        origin: "schematic",
                        scope: node.child_scope ?? undefined,
                      }),
                    );
                  }}
                  onError={fail}
                />
              ) : (
                <div className="welcome">
                  <div className="welcome-symbol">⌘</div>
                  <h1>See your hardware.</h1>
                  <p>
                    Explore RTL structure, follow signals, and inspect
                    simulation results in one workspace.
                  </p>
                  <div className="welcome-actions">
                    <button
                      onClick={() => {
                        setText("");
                        setModal("Open snapshot");
                      }}
                    >
                      Open saved snapshot
                    </button>
                    <button
                      onClick={() => {
                        setJob(undefined);
                        api<Job>("probe", { profile }).then(setJob).catch(fail);
                      }}
                    >
                      Check toolchain
                    </button>
                  </div>
                  <p className="hint">
                    Sources stay on your machine. Each waveform is bound to one
                    design snapshot.
                  </p>
                </div>
              )}
            </div>
          }
        />
      </Workspace>
      <footer inert={!!working.settingsSection}>
        <span className={`status-dot ${busy ? "busy" : ""}`} />
        <span>{job ? `${job.kind}: ${job.status}` : "Ready"}</span>
        {job?.status === "running" && (
          <button
            onClick={() => {
              void api("cancel", { id: job.id }).catch(fail);
            }}
          >
            Cancel job
          </button>
        )}
        <span className="footer-spacer" />
        <span>
          {profile.provider === "docker"
            ? "Docker toolchain"
            : "Native toolchain"}
        </span>
      </footer>
      <ProjectDialogs
        controller={working}
        onError={fail}
        lintPreferences={lint.settings}
        onLintPreferences={lint.setSettings}
        snapshot={snapshot}
      />
      {modal && (
        <div className="modal-backdrop">
          <section className="modal">
            <div className="modal-heading">
              <h2>{modal}</h2>
              <button onClick={() => setModal(undefined)}>×</button>
            </div>
            {modal === "Toolchain" && (
              <p>
                Edit the native/Docker profile. Executable paths and environment
                belong to this machine.
              </p>
            )}
            {modal === "Manual binding" && (
              <>
                <p>Select an exact-width waveform declaration:</p>
                <select value={text} onChange={(e) => setText(e.target.value)}>
                  <option value="">Choose signal</option>
                  {wave?.variables
                    .filter((v) => v.width === selectedSignal?.width)
                    .map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.path.join(".")}
                      </option>
                    ))}
                </select>
              </>
            )}
            {modal !== "Manual binding" && (
              <textarea
                aria-label={`${modal} input`}
                rows={
                  [
                    "Toolchain",
                    "Project configuration",
                    "Source",
                    "Probe results",
                    "Report",
                  ].includes(modal)
                    ? 18
                    : 3
                }
                value={text}
                onChange={(e) => setText(e.target.value)}
                readOnly={["Source", "Probe results", "Report"].includes(modal)}
                spellCheck={false}
              />
            )}
            {modal === "Import waveform" && (
              <>
                <label>DUT scope as JSON path segments</label>
                <input value={aux} onChange={(e) => setAux(e.target.value)} />
              </>
            )}
            {!["Source", "Probe results", "Report"].includes(modal) && (
              <button
                className="primary"
                onClick={() => {
                  void submitModal();
                }}
              >
                Apply
              </button>
            )}
          </section>
        </div>
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  new URLSearchParams(location.search).has("symbol-gallery") ? (
    <SymbolGallery />
  ) : (
    <App />
  ),
);
