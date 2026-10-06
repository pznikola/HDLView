import React, { useCallback, useEffect, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./api";
import { parseProfile } from "./profile";
import { Schematic } from "./components/Schematic";
import { Waveform } from "./components/Waveform";
import { nextSelection, type Selection, formatValue } from "./selection";
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
  { id: "source", label: "Source RTL" },
  { id: "elaborated", label: "Elaborated RTL" },
  { id: "generic", label: "Generic gates" },
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
  const { scope, navigate: setScope, reset: resetScope } = navigation;
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
  const [drawer, setDrawer] = useState(false);
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
  const [explorer, setExplorer] = useState<"sources" | "design">("sources");
  const [editorCollapsed, setEditorCollapsed] = useState(false);
  const [schematicCollapsed, setSchematicCollapsed] = useState(false);
  const [editorWidth, setEditorWidth] = useState(45);
  const [waveformHeight, setWaveformHeight] = useState(35);
  const clearWorkspace = useCallback(() => {
    generation.current += 1;
    setRestoring(false);
    setRep("elaborated");
    setEditorCollapsed(false);
    setSchematicCollapsed(false);
    setEditorWidth(45);
    setWaveformHeight(35);
    setSnapshot(undefined);
    setGraph(undefined);
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
  );
  const markBuilt = working.markBuilt;
  const project = working.workspace?.project;
  const path = working.workspace?.path ?? "";
  const workspaceEpoch = generation.current;
  const configuredSimulations =
    snapshot?.project.simulations ?? project?.simulations;
  const simulations = configuredSimulations;
  const availableSimulations = Object.entries(simulations ?? {}).filter(
    ([, config]) => canSimulate(config, snapshot),
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
      setProfile(s.profile);
      setRep(s.representation);
      resetScope([s.project.top]);
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
      api<Binding[]>("bindings", { snapshot_id: r.snapshot_id, run_id: r.id }),
    ]);
    if (current !== generation.current) return;
    setRun(r);
    setWave(info);
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
  }, [snapshot, scope, focus, splitBuses, fail]);
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
      if (drawer) api<string>("logs").then(setLogs).catch(fail);
    }, 500);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [job, drawer, acceptSnapshot, acceptRun, fail, markBuilt]);
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
        (!project?.physical?.clock_port || !project.physical.clock_period_ns)
      ) {
        working.setModal("settings");
        throw new Error(
          "Set technology, clock port, and clock period in Project Settings before a mapped or physical build.",
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
    setError("");
    try {
      setJob(
        await api<Job>("simulate", {
          snapshot_id: snapshot.id,
          name: simulation,
        }),
      );
    } catch (e) {
      fail(e);
    }
  }
  function pickSignal(ids: string[]) {
    // The graph supplies the clicked declaration/endpoint first. A missing pin
    // must never fall through to an electrically connected but delayed net.
    const id = ids[0];
    if (!id) return;
    const binding = bindings.find((b) => b.signal_id === id);
    const variableId =
      binding && ["exact", "manual"].includes(binding.status)
        ? binding.variable_ids[0]
        : undefined;
    setSelection((p) =>
      nextSelection(p, { origin: "schematic", signalId: id, variableId }),
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
  const selectedSignal = graph?.signals.find(
    (s) => s.id === selection?.signalId,
  );
  const selectedBinding = bindings.find(
    (b) => b.signal_id === selection?.signalId,
  );
  const busy = restoring || job?.status === "running";
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
      <header>
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
      <nav className="workflow">
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
        <button
          disabled={
            !snapshot ||
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
      <main>
        <aside className="sidebar">
          <div className="explorer-tabs">
            <button
              className={explorer === "sources" ? "active" : ""}
              onClick={() => setExplorer("sources")}
            >
              Sources
            </button>
            <button
              className={explorer === "design" ? "active" : ""}
              onClick={() => setExplorer("design")}
            >
              Design
            </button>
          </div>
          {explorer === "sources" ? (
            <ProjectSources
              controller={working}
              onOpen={(file) => {
                setEditorCollapsed(false);
                void working.openFile(file).catch(fail);
              }}
              busy={busy || working.job?.status === "running"}
              onError={fail}
            />
          ) : (
            <>
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
                          style={{ paddingLeft: 12 + (s.path.length - 1) * 16 }}
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
                        onClick={() => pickSignal([s.id])}
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
                            ? formatValue(values[variableId] ?? "", "hex")
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
            </>
          )}
        </aside>
        <div className="workspace">
          <div className="workspace-tools">
            <button onClick={() => setEditorCollapsed(!editorCollapsed)}>
              {editorCollapsed ? "Show Editor" : "Hide Editor"}
            </button>
            <button onClick={() => setSchematicCollapsed(!schematicCollapsed)}>
              {schematicCollapsed ? "Show Schematic" : "Hide Schematic"}
            </button>
            {working.stale && snapshot && (
              <span>Sources changed · rebuild needed</span>
            )}
          </div>
          <div
            className="workspace-panes"
            style={{
              gridTemplateRows:
                run && wave
                  ? `minmax(120px, ${100 - waveformHeight}fr) 8px minmax(120px, ${waveformHeight}fr)`
                  : "minmax(0, 1fr) auto",
            }}
          >
            <div
              className="workbench"
              style={{
                gridTemplateColumns:
                  !editorCollapsed && working.activeTab && !schematicCollapsed
                    ? `${editorWidth}% 8px minmax(0,1fr)`
                    : "minmax(0,1fr)",
              }}
            >
              {working.activeTab && (
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
                  <SourceEditor
                    tab={working.activeTab}
                    tabIds={working.tabs.map((t) => t.id)}
                    onChange={working.updateTab}
                  />
                </div>
              )}
              {!editorCollapsed && working.activeTab && !schematicCollapsed && (
                <div
                  className="pane-splitter"
                  role="separator"
                  aria-label="Editor width"
                  aria-orientation="vertical"
                  tabIndex={0}
                  aria-valuenow={editorWidth}
                  aria-valuemin={20}
                  aria-valuemax={80}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowLeft")
                      setEditorWidth((w) => Math.max(20, w - 5));
                    if (e.key === "ArrowRight")
                      setEditorWidth((w) => Math.min(80, w + 5));
                  }}
                  onPointerDown={(e) =>
                    e.currentTarget.setPointerCapture(e.pointerId)
                  }
                  onPointerMove={(e) => {
                    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
                    const bounds =
                      e.currentTarget.parentElement?.getBoundingClientRect();
                    if (bounds)
                      setEditorWidth(
                        Math.min(
                          80,
                          Math.max(
                            20,
                            (100 * (e.clientX - bounds.left)) / bounds.width,
                          ),
                        ),
                      );
                  }}
                  onPointerUp={(e) =>
                    e.currentTarget.releasePointerCapture(e.pointerId)
                  }
                />
              )}
              {!schematicCollapsed && (
                <div className="design-pane">
                  <div className="breadcrumbs">
                    <button
                      aria-label="Previous scope"
                      disabled={!navigation.canBack}
                      onClick={navigation.back}
                    >
                      ←
                    </button>
                    <button
                      aria-label="Next scope"
                      disabled={!navigation.canForward}
                      onClick={navigation.forward}
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
                      splitBuses={splitBuses}
                      onSplitBuses={() => setSplitBuses(!splitBuses)}
                      selected={selection?.signalId}
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
                            scope: node.child_scope,
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
                            api<Job>("probe", { profile })
                              .then(setJob)
                              .catch(fail);
                          }}
                        >
                          Check toolchain
                        </button>
                      </div>
                      <p className="hint">
                        Sources stay on your machine. Each waveform is bound to
                        one design snapshot.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
            {run && wave && (
              <div
                className="wave-splitter"
                role="separator"
                aria-label="Waveform height"
                aria-orientation="horizontal"
                aria-controls="waveform-pane"
                tabIndex={0}
                aria-valuenow={Math.round(waveformHeight)}
                aria-valuemin={20}
                aria-valuemax={70}
                aria-valuetext={`${Math.round(waveformHeight)}%`}
                onKeyDown={(e) => {
                  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key))
                    return;
                  e.preventDefault();
                  setWaveformHeight((height) =>
                    e.key === "Home"
                      ? 20
                      : e.key === "End"
                        ? 70
                        : Math.min(
                            70,
                            Math.max(
                              20,
                              height + (e.key === "ArrowUp" ? 5 : -5),
                            ),
                          ),
                  );
                }}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.preventDefault();
                  e.currentTarget.focus();
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                  if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
                  const bounds =
                    e.currentTarget.parentElement?.getBoundingClientRect();
                  if (bounds)
                    setWaveformHeight(
                      Math.min(
                        70,
                        Math.max(
                          20,
                          (100 *
                            (bounds.bottom -
                              e.clientY -
                              e.currentTarget.offsetHeight / 2)) /
                            (bounds.height - e.currentTarget.offsetHeight),
                        ),
                      ),
                    );
                }}
                onPointerUp={(e) => {
                  if (e.currentTarget.hasPointerCapture(e.pointerId))
                    e.currentTarget.releasePointerCapture(e.pointerId);
                }}
              />
            )}
            {run && wave ? (
              <Waveform
                key={run.id}
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
        </div>
        <aside className="inspector">
          <div className="panel-heading">INSPECTOR</div>
          {selectedSignal ? (
            <>
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
              Select a signal, wire, or cell to inspect it.
            </p>
          )}
          {inspect && (
            <>
              <h3>{inspect.label}</h3>
              <p>{inspect.kind}</p>
              {inspect.child_scope && (
                <button onClick={() => setScope(inspect.child_scope!)}>
                  Enter instance
                </button>
              )}
              <div className="pin-list">
                {inspect.ports.map((p) => (
                  <button key={p.id} onClick={() => pickSignal(p.signal_ids)}>
                    {p.direction === "output" ? "→" : "←"} {p.label}
                  </button>
                ))}
              </div>
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
                <summary>Process / cell details</summary>
                <pre>
                  {JSON.stringify(
                    snapshot?.design.modules[
                      snapshot.design.scopes.find(
                        (s) => JSON.stringify(s.path) === JSON.stringify(scope),
                      )?.module || ""
                    ]?.cells.find((c) => c.name === inspect.label)?.attributes,
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
                {JSON.stringify(snapshot.physical_run.state.metrics, null, 2)}
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
        </aside>
      </main>
      <footer>
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
        <button
          onClick={() => {
            setDrawer(!drawer);
            api<string>("logs").then(setLogs).catch(fail);
          }}
        >
          Logs {drawer ? "⌄" : "⌃"}
        </button>
      </footer>
      {drawer && (
        <section className="log-drawer">
          <pre>{logs || "Tool logs will appear here."}</pre>
        </section>
      )}
      <ProjectDialogs controller={working} onError={fail} />
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
createRoot(document.getElementById("root")!).render(<App />);
