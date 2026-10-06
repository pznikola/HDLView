# HDLView implementation specification

Accepted product plan, recorded 6 October 2026. This file is an implementation and continuation specification for another AI agent. It describes the complete intended release; [QUALIFICATION.md](docs/QUALIFICATION.md) records what the current implementation actually demonstrates and what remains unqualified.

## 1. Product and architecture

Build a Linux-first desktop application for small and medium ASIC designs targeting SKY130 and IHP SG13G2. Users must be able to generate source RTL, elaborated RTL, and synthesized/post-layout netlist schematics from Verilog or SystemVerilog; run/import simulations; select signals in both directions; and launch LibreLane and inspect its results.

**Binding rule: each simulation session binds one waveform to one immutable schematic snapshot.** The user chooses a representation before creating the session. Switching representations requires another session. Never carry a waveform automatically between RTL, synthesized, and post-layout views. Even within the same stage, missing dumps must stay unavailable, and similarly named signals must never be substituted.

| Component                | Selection                                                           |
| ------------------------ | ------------------------------------------------------------------- |
| Desktop shell            | Tauri 2                                                             |
| UI                       | React, TypeScript, Vite                                             |
| Application core and CLI | Rust, independent of Tauri                                          |
| Layout                   | elkjs in a Web Worker, layered/orthogonal, deterministic port order |
| Schematic rendering      | Custom SVG                                                          |
| Waveforms                | Wellen VCD/FST parsing, Canvas rendering, virtualized rows          |
| Compilation              | Yosys, Slang                                                        |
| Physical implementation  | LibreLane                                                           |

Do not add a separately hosted application service. Reuse existing HDL parsers, simulators, synthesis, timing, placement/routing, and extraction engines.

Support Verilog/SystemVerilog projects only. Remove VHDL/GHDL support and reject unsupported projects without replacing the current workspace. Icarus and explicitly selected Verilator handle RTL and compatible gate runs. A shared testbench configuration compiles captured RTL or the exact exported Verilog netlist according to the selected snapshot. Icarus is the SDF backend; Verilator is not.

Physical-design integration configures and launches LibreLane, collects progress/reports/artifacts, and creates a matching post-layout snapshot. Detailed layout viewing stays in external tools.

## 2. Research and reuse

Read [the visualization research](docs/research/rtl_visualization_tools.md) for the
tool survey and inspected upstream revisions. Local reference checkouts are
optional research material and are not required to build or run HDLView.

| Project/group                                   | Reuse decision                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Yosys, Slang                                    | Core external compilation tools                                                            |
| NetlistSVG                                      | Study symbols, bus splitting/joining, static SVG export                                    |
| d3-hwschematic                                  | Study hierarchy, net selection, Yosys/ELK conversion                                       |
| ELK/elkjs                                       | Reuse the layout library directly                                                          |
| FEntwumS.NetlistViewer                          | Hierarchy/source-navigation reference; do not adopt its separate UI/backend architecture   |
| DigitalJS/yosys2digitaljs                       | Symbols and interaction reference; do not replace HDL simulation with its simulation model |
| TerosHDL                                        | Project/tool-adapter/diagnostic reference                                                  |
| HAL                                             | Bounded fan-in/fan-out and library-aware exploration reference                             |
| VeriSim, OpenCircuitX, Verilog-IDE              | Integrated workflow reference                                                              |
| Sphinx HDL Diagrams, Graphviz                   | Reproducible static export reference                                                       |
| Pyverilog                                       | Behavioral dataflow reference, not a common parser for all three languages                 |
| CircuitVerse, Diagrammer, YosysJS-netlistviewer | Secondary references                                                                       |
| sv-pathfinder, AURORA, RTL Bench                | UX references only; restrictive licensing/unavailable backends exclude core dependency use |
| Surfer, Vaporview                               | Waveform interaction references; reuse Wellen rather than their whole UI integrations      |

Pin dependencies and retain licenses/notices. In particular, inspect ELK's EPL terms rather than assuming all dependencies are MIT/Apache. Wellen is BSD-3-Clause. See `docs/DEPENDENCIES.md` and the lockfiles.

The originally supplied image is `hpretl/iic-osic-tools:2025.12`, digest `sha256:92961478ad3c4f508efb42d9ccdba12ab262eb42a14926d2bd49862230ba8521`. Initial research identified Yosys 0.60 with Slang/GHDL plugins, Slang 9.1.204, GHDL 6 development, Icarus 13 development, Verilator 5.042, LibreLane 2.4.10, and both PDKs. Basic frontend, mapping, and synthetic SDF feasibility did not establish full flow qualification.

**Implementation finding:** the original image's IHP PDK and LibreLane generations differ. `tools/Dockerfile` now specifies the derived compatibility stack. Read the qualification ledger before changing versions. Preserve tool-specific environments, including vvp library search paths and the correct OpenROAD/OpenSTA generation for the chosen LibreLane version.

## 3. Projects, immutable artifacts, and execution

Keep these versioned interfaces:

- `ProjectConfig`: ordered sources, per-file language/standard, includes, defines, top, parameters, simulation configurations, physical configuration.
- `ToolchainProfile`: native/Docker provider, executable/plugin paths, environment, immutable image identity, PDK roots, timeout and capability information.
- `DesignSnapshot`: representation, input/artifact fingerprints, hierarchy, normalized graph, source references, diagnostics and tool identities.
- `SimulationRun`: one bound snapshot, actual simulated inputs, simulator/testbench/DUT scope, trace/dump information, optional models/SDF/corner/delay selection.
- `PhysicalRun`: LibreLane configuration and dependency identity, status, reports, matching output artifacts, and independently preserved signoff outcomes.
- `SignalBinding`: schematic declaration/endpoint, waveform declaration, bit correspondence, resolution status, and matching evidence.

Shareable configuration belongs in `hdlview.project.json`. Machine-specific paths belong in user toolchain settings. Captured inputs and generated artifacts must not overwrite source HDL.

### Project creation and imports

Use a **File** menu containing Create New Project, Open Existing Project, Add New Files, Save Project, and Close Project. Keep Project Settings and Toolchain to its left-side command group, followed by the project name; place the logo at the far right. Preserve the second-row stage/build/simulation controls. Commands support keyboard navigation, Escape/outside dismissal, and focus restoration; project-changing commands are unavailable during jobs, with cancellation still accessible.

New Project has Project, Sources, and Review steps: name/directory, fixed Verilog/SystemVerilog language, and SKY130 or IHP SG13G2 technology; independently import source groups; review order/exclusions; then Create New Project. Keep a backend draft and publish configuration only on the final successful action. Cancellation preserves the current workspace and writes no configuration. Clock settings belong in Project Settings before mapped/physical builds. Require explicit revision-checked overwrite for existing configuration.

Reference original files without copying them into the project. Empty projects and unset tops may be saved; separate configuration validation from build readiness. Build requires design sources and a valid, user-entered top. Ordinary settings expose top, standard, compilation order, includes, and defines. Retain advanced JSON for simulation and physical settings.

Project schema **3** is independent of snapshot/run schemas. Load schema 1/2 Verilog/SystemVerilog documents without writes; migrate on explicit save. Merge simulation then gate-simulation sources/headers in first-occurrence order, deduplicate resolved identities, and register configuration testbenches without changing their ordered lists. Keep only design/simulation import groups, preserving distinct working-directory records; remove project family, VHDL libraries, gate-source arrays, and simulation stages. VHDL/GHDL configurations are unsupported. Preserve technology, roots, physical settings, and named simulations. File references are project-relative strings or `{root, path}` objects. Roots may be outside the configuration directory, preferably recorded relatively; paths beneath roots cannot escape them. Apply references to sources, headers, includes, assets, testbenches, models, SDF, and SDC. Legacy SV artifacts use the same read-only conversion boundary, preserve original fingerprints, and can conservatively show Rebuild required after migration.

Capture resolves roots into separate immutable input namespaces, preserves hierarchy, produces compiler-facing relative paths, and records original-source mappings. External working directories never enter tool containers: Docker compiles read-only captured inputs. Open validates JSON before prompting about current unsaved changes and activating the new project. Restore each project's last valid schematic and matching waveform automatically from machine-local checkpoints keyed by canonical configuration path. Restore default tabs/layout/scope/cursor/zoom/rows. Validate provenance, captured fingerprints, and snapshot/run binding. Missing or corrupt artifacts produce warnings while preserving available sources/schematic; changed working inputs show Rebuild required. Never compile/simulate during opening, and do not associate the old global session with an arbitrary project.

Save Project saves edited documents, configuration, and artifact references. Close prompts Save/Discard/Cancel when dirty; failed saves prevent closure. Flush checkpoints before successful transitions, release parser resources, and retain original files/artifacts.

Imports must implement:

- Multiple-file selection; recursive folder discovery of `.v`/`.sv`/`.vh`/`.svh`. Headers are not standalone compilation units and register their containing include directories.
- Separate root labels and preserved directories for duplicate basenames. Deterministic relative-path folder order; filelists retain listed order. Provide move-up/down controls rather than claiming alphabetical order resolves package dependencies. Remove source-panel import/rescan buttons; use File → Add New Files and folder/filelist context actions.
- Skip `.git`, `node_modules`, `target`, `.hdlview`, `dist`, and other generated caches. Do not follow directory symlinks. Report skips in review; explicit selection may add excluded files or select the intended directory.
- Review exclusions and explicit design/header/simulation roles. Accept only Verilog/SystemVerilog. Enforce picker and Rust checks; explicit unsupported files/filelists fail transactionally, while folders skip VHDL and report exclusions. Never infer testbenches from names.
- Explicit **Rescan Folder** and **Reimport Filelist** previews. Folder rescans preserve assigned order; filelist reimports apply the reviewed list order. Preserve roles, and preview additions/missing files. Removing an entry never deletes its original file.

Common `.f`/`.flist` syntax includes ordered and quoted paths, comments, nested `-f`/`-F`, `+incdir+`, and `+define+`. Interpret the selected list with `-F` semantics: contents relative to that list's directory. Nested `-f` contents resolve relative to the import working directory, configurable before parsing and in review, defaulting to the selected list's directory. Substitute import-environment variables without shell execution. Undefined variables, list cycles, missing paths, unsupported switches, and conflicting defines are located import errors. Failed imports cannot partially modify a project. Persist expanded configuration plus original import references; do not reread lists implicitly at build time.

Use Tauri's official dialog plugin with scoped picker permissions; filesystem operations and parsing stay in Rust core. Expose typed project/settings, preview/application, rescan, document-read, and revision-checked-save service operations. Reuse cancellable jobs for scans and imports.

The common runner must use argument arrays, isolated work directories, reproducible command/environment manifests, structured diagnostics, progress/log collection, cancellation, time limits, and atomic publication. Generated Yosys/Tcl/Verilog text needs language-specific escaping. Native cancellation kills the process group; Docker cancellation terminates the container. Parser subprocesses must also be killable.

Docker mounts captured inputs/PDKs read-only and outputs writable. No VNC/desktop or nested Docker is needed. Do not mount the Docker socket inside tool containers. Run LibreLane directly in the selected image.

Cache only when actual input contents, settings, compiler/plugin identities, and relevant PDK/config contents are accounted for. Conservative rebuilding is preferable to unsafe cache reuse. Edits create a new snapshot; old sessions keep their original inputs and trace. Reopening must detect changed artifacts.

## 4. Representations

### Source RTL

Build behavioral/dependency graphs for definitions, instance occurrences, processes, concurrent assignments, operators, and named reads/writes. Preserve source locations, parameters/generics, symbolic generates, and expandable process details. This view explains source behavior; it is not a physical gate claim.

Use isolated pinned `pyslang` syntax/semantic APIs for SV/Verilog. Do not reconstruct source behavior from synthesis. Unsupported syntax/type/connectivity must become an explicit diagnostic or opaque node. Never infer invented connectivity from text regexes.

Source and elaborated sessions may simulate their corresponding HDL sources, but compiler-only temporaries without simulator declarations remain unavailable.

### Elaborated RTL

Use Slang/Yosys. Resolve parameters, widths, generate blocks, and instances, then lower processes into registers/muxes/operators while retaining word operations and memories.

Baseline:

```text
frontend import
hierarchy validation
proc
memory_collect
check
write_rtlil
write_json
```

Do not run ABC, technology mapping, FSM recoding, or aggressive optimization here. Yosys JSON cannot represent unlowered processes. Probe frontend hierarchy options rather than assuming every installed plugin has identical behavior. Preserve compiler-provided source/name/hierarchy metadata; explicitly report lost identities.

### Generic, mapped, and post-layout gates

Provide PDK-independent generic synthesis. Use pinned LibreLane synthesis configuration for production PDK mapping, including combinational and sequential mapping, exclusions, and technology mappings. A bare `abc -liberty` feasibility test is not the production PDK flow.

Defaults are `sky130A/sky130_fd_sc_hd` and `ihp-sg13g2/sg13g2_stdcell`. Record the selected corner.

**Import the exact exported Verilog netlist that simulation consumes**, with library interfaces and no optimization/resynthesis. Derive pin directions/labels from library metadata. Physical-only filler cells may require interfaces extracted from simulation models because timing libraries omit them. Blackbox interfaces are never simulation models.

Keep actual flattening, buffers, CTS cells, and other physical modifications. Render unknown cells with labeled ports. Logical and power pins need distinct treatment.

## 5. Identity and cross-probing

Compilation data and layout data must be separate. Distinguish definitions from occurrences; signal declarations from aliases; buses from bits; constants from wire identities; cell pins from parent nets; source dependencies from electrical connectivity.

Yosys numeric bits are module/snapshot-local. IDs must include snapshot and instance context. Keep path segments losslessly, including escaped identifiers, original spelling, signedness, bit indices, declared offsets and direction. Preserve case-sensitive Verilog identifiers.

Binding order:

1. Explicit waveform testbench-to-DUT scope mapping.
2. Exact hierarchical declaration/range match.
3. Documented frontend transformations and preserved provenance.
4. Validated aliases and bit/slice correspondence.
5. Explicit user mappings for unresolved imports.

No basename or fuzzy auto-binding. Persist mappings only for matching snapshot/trace fingerprints. Delayed endpoints can disagree at the same cursor time even when electrically connected; never merge their waveform identities.

Interaction acceptance:

- Wave row/trace selection reveals and selects the corresponding schematic signal.
- Schematic signal selection reveals/adds/selects its waveform row.
- Module selection chooses the corresponding waveform scope; adding all scope signals is separate.
- Cell selection exposes pins without arbitrarily choosing an output.
- Cursor values update only bound visible signals.
- Missing, ambiguous, range-mismatched, and absent-scope bindings stay distinguishable.
- Selection origin/sequence prevent event feedback loops.

## 6. Workspace and performance

Provide hierarchy, schematic, waveform, and collapsible diagnostic/job panels. Include pan/zoom/fit, search, breadcrumbs, navigation history, instance/process exploration, buses, source navigation, highlighting, bounded fan-in/fan-out, and current-view SVG export. Handle constants, feedback, multiple drivers, inouts, and unknown cells explicitly.

The left sidebar has **Sources** immediately after opening/creating a project and **Design** after compilation. Sources groups directories/files under Design Sources, Simulation Sources, and Filelists and Auxiliary Files. Compilation order is a separate settings list. Clicking a source opens an editor tab with root/directory labels distinguishing duplicate basenames.

Place editor and schematic beside each other with a keyboard-accessible adjustable splitter and independent collapse controls. Waveforms remain below both, with a keyboard-accessible horizontal divider for height adjustment. Resizing preserves selection, cursor/zoom, and schematic layout; virtualized waveform rows follow the visible pane height. Use CodeMirror 6 with minimal extensions and the Verilog stream mode for highlighting, line numbers, indentation, search/replace, history, dirty tabs and document Save. File → Save Project and `Ctrl+Shift+S` save modified files and configuration; `Ctrl+S` saves the active file.

Preserve UTF-8 BOM and line endings; explicitly diagnose unsupported encoding, missing files, and permissions. Compare current content against the opened/saved revision before writing. A conflict retains the buffer and offers Reload, Overwrite, or Cancel. Modified-tab closure, project switching, and desktop closure offer Save/Discard/Cancel; save failures prevent leaving. Building with unsaved changes offers Save All and Build or Cancel. Saved source/config changes mark the displayed design stale without automatic rebuild.

Schematic source navigation opens captured snapshot text read-only at the recorded location. A separate Open Working File action uses original-source mappings. Never apply old snapshot line numbers to edited working files. Existing snapshots and waveform sessions remain immutable.

Lay out only the current module or bounded neighborhood; automatically limit large views to 2,000 nodes/cells and offer focused exploration. Use deterministic port ordering, orthogonal layered layout, and snapshot-scoped caching. Selection/cursor movement must not request layout.

Waveforms use Wellen outside the UI thread. Query only visible rows/windows, preserve aliases, X/Z values, radix, bus bits, integer timestamps/timescale, and pixel-level activity indications. Serialize timestamps as strings. Do not assume every format is demand-loaded; measure indexing time and peak memory independently. Add disk-backed indexing if needed for the supported memory budget.

Targets on a documented Linux SSD workstation with at least 16 GB RAM:

- bounded navigation of 100,000-cell designs;
- a 1 GB VCD and representative FST;
- ordinary loaded selection below 100 ms;
- cached values for 200 visible signals below 100 ms;
- initial 1,000-node layout below 3 seconds;
- cancellation during parsing, compilation, layout, and physical jobs.

Targets remain targets until measured; report raw evidence and counterexamples.

## 7. Simulation and physical integration

| Run                       | Backend                                          |
| ------------------------- | ------------------------------------------------ |
| Verilog/SystemVerilog RTL | Icarus or explicitly selected Verilator          |
| Zero-delay Verilog gates  | Icarus; Verilator only after model qualification |
| SDF-annotated gates       | Icarus only                                      |

Keep synthesis and testbench sources separate. Configure testbench top, DUT instance path, parameters, runtime arguments, stop time, dump scope, and expected trace. Instrument only generated run files; never edit user HDL. Testbenches must be simulator-compatible; do not promise automatic translation. Shared testbenches should use named ports and public DUT interfaces because export can reorder declarations and remove internal RTL hierarchy. Ordinary configurations apply to either stage; SDF is gate-only. Explicit model files are compiled only for gates. Waveforms remain bound to one immutable snapshot/representation.

Resolve actual PDK functional/timing simulation model sets, primitives, include paths, power conventions, and defines. Record their identity. For SDF use tested `-gspecify`/`-ginterconnect`, the exact DUT instance, matching SDF/netlist/models, explicit corner, timescale and min/typ/max selection. Detect malformed/missing/unmatched/ignored annotations. Unsupported `TIMINGCHECK` and conditional delays must remain visible and separate from STA.

LibreLane adapter sequence:

1. Collect top, clocks, SDC, PDK/library, floorplan/utilization and macro options.
2. Export normalized Verilog for frontend compatibility where necessary.
3. Launch a pinned Classic flow in a unique directory.
4. Show steps/logs/reports and completion/failure.
5. Collect final artifacts through structured state/output interfaces.
6. Import the exact final simulation netlist as a new post-layout snapshot.
7. Simulate with matching final SDF/models/corner; never use pre-route schematics with post-route SDF.

DRC/LVS/STA outcomes remain independent of simulation success. A completed flow with deferred checker failures can expose final artifacts while remaining visibly failed for signoff.

## 8. Ordered milestone gates

Each milestone needs a runnable demonstration and automated acceptance checks. Existing code is organized in `docs/ARCHITECTURE.md`; do not restart from scratch.

Execute the project-workspace amendment in this order while retaining all original HDL/simulation/physical gates:

1. Project contracts and capture: v1 compatibility, v2 roots, empty projects, external capture, original mappings.
2. Importers and controls: files/folders/filelists, review, order, rescans, native selection.
3. Source workspace: explorer, resizable editor, conflicts/prompts, captured-source navigation.
4. Integration: browser workflows and real native/Docker builds of UI-created projects, packaged Linux picker/editor startup.

Completion means a user can create or open a project, import RTL without editing JSON, browse/edit/save original sources, and build a matching schematic while preserving session correctness.

| Milestone          | Completion gate                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 0. Dependencies    | Pin image/tools/libraries; reproduce both PDK mapping tests, frontend hierarchy, model compilation, supported SDF features |
| 1. Core            | Project/schema, immutable capture, native/Docker jobs, cancellation, diagnostics, CLI on a small design                    |
| 2. Linking         | Hierarchical Verilog build/simulation, repeated instances and buses, bidirectional selection                               |
| 3. Representations | Source and elaborated views for Verilog/SystemVerilog, specializations, explicit unsupported constructs                    |
| 4. RTL simulation  | Icarus/Verilator jobs and imported VCD/FST all share binding/session rules                                                 |
| 5. Gates           | Both PDKs map and simulate exact netlists; stage restrictions and library models verified                                  |
| 6. Physical        | Each PDK completes a small full flow; final netlist/SDF/layout/reports imported with checker outcomes preserved            |
| 7. SDF             | Both PDKs exercise delays/annotation errors/corners; unsupported coverage reported independently                           |
| 8. Release         | Performance corpus, restoration, native/Docker parity, Linux package/smoke, examples, notices and documentation            |

The early Verilog demonstration is not final scope. Release acceptance additionally requires the documented source/gate/physical workflows and qualification corpus.

## 9. Acceptance corpus for continuation

Expand tests using small focused fixtures for repeated instances, parameter specializations, generates, includes/packages, registers/latches/muxes/arithmetic/memories/constants/feedback/blackboxes, ascending and descending/nonzero ranges, slices/concatenations/signed values/escaped names, duplicate names/DUT instances, aliases/X/Z/large timestamps/missing dumps/ambiguous roots, changed sources and stage mismatch, and delayed endpoint disagreement.

Project-workspace acceptance additionally covers existing JSON and empty new Verilog/SystemVerilog projects; files, nested/external roots, duplicate basenames, headers, missing paths, spaces; list order/quoting/comments/nested flags/includes/defines/environment/cycles/unsupported switches; manual ordering; editing originals, BOM/endings, conflicts, cancelled pickers, failed writes, dirty tab/project/window transitions, non-destructive rescans; and new builds whose previous waveform/captured sources remain unchanged. Keep existing cross-probing and stage-binding regressions. Browser pickers may be injected, but backend imports/saves use real temporary files. Qualify native picker and editor startup in the packaged Linux app.

Validate known testbench assertions and trace transitions. Exercise both PDK model sets, cell/interconnect delays, min/max selection, wrong annotation scope, unsupported timing diagnostics, and exact final-netlist/SDF pairing. Preserve DRC/LVS/STA reports independently.

Exercise paths with spaces, missing plugins/Docker/environment/PDK files, invalid HDL, simulator failure, cancellation and interrupted jobs. Compare native/Docker normalized identity/connectivity for compatible tool versions, not raw generated names.

Use Rust tests, frontend tests, browser interaction tests, and packaged Linux smoke tests. Include real Docker toolchain qualification for releases. Update `docs/QUALIFICATION.md` with evidence, limitations, and failed checks rather than marking broad milestones complete based on one counter example.

Project-lifecycle acceptance additionally covers cancelled drafts without writes, both technology presets, grouped imports through all methods, backend language-policy bypass attempts, shared testbench reuse, schema-1/2 migration and unsupported VHDL rejection, menu/context keyboard behavior, and independent automatic restoration of two projects. Verify missing/corrupt/stale/mismatched artifacts, saved-original conflicts and failed transitions, job cancellation, and packaged Linux menu/native-picker/reopening behavior. No full UI-layout restoration, recent-project menu, extra top-level menus, or unsaved-buffer recovery is included in this amendment.

## 10. Live editor linting amendment

Analyze working design/testbench files, including unsaved buffers, independently
of displayed schematics and waveforms. Use pinned pyslang 10.0.0 for preprocessing,
syntax and semantic diagnostics, and the tool image's Verible
`v0.0-3724-gdec56671` for configurable style. Defer Verilator lint, LSP, formatting,
and autofix. Pin CodeMirror lint 6.9.5 and retain actual dependency notices.

Run after 750 ms without typing and after working-file open/save/reload, context
or relevant settings changes, and application focus. Exclude captured and auxiliary
tabs. Show red/yellow underlines, gutter markers, engine/code hover messages,
Problems in the Logs drawer, clickable ranges/related locations, and F8/Shift+F8.
Checks must not steal focus, open panels, reset history/selection/scroll, write
originals, mark rebuilds, or create snapshots.

Live linting and Style checks are machine-local preferences keyed by canonical
project path, outside project JSON and compilation fingerprints. The default
style preset is `no-trailing-spaces`, `posix-eof`,
`forbid-consecutive-null-statements`, `module-port`, and `module-parameter`.
Only `.rules.verible_lint` beside the project configuration replaces this preset,
using `--ruleset=none`; preserve inline waivers. Style findings are warnings.

Rust owns typed `EditorLintRequest`, `EditorLintResult`, and `EditorDiagnostic`
contracts, membership/context validation, temporary captured input namespaces,
original-file mappings, hashes, and byte-to-UTF-16 conversion against normalized
analyzed text. Overlay every open working HDL buffer. Preserve macro/include
origins and related notes. Docker receives captured inputs read-only; never mount
external working-source directories. Diagnostics from unsuccessful HDL analysis
are normal results; missing tools, malformed rules, and unsupported parser output
are explicit engine failures or incomplete analysis.

Design context uses ordered working sources, top, standard, includes, defines,
and specialization. Simulation context adds one configuration's ordered testbenches,
merged defines and top, applying parameter overrides at its DUT scope. Resolve
selected or unique file ownership; expose an editor selector for ambiguity.
Missing tops/configurations provide syntax/style checks with limited status.
Headers compile through includers; unreferenced headers get applicable style
checks and explanation. Do not load gate netlists, PDK models, or SDF. Slang's
2017/2023 support differs from Icarus's 2012 dialect; report this difference and
leave actual simulator compilation authoritative.

Use cancellable processes through the runner, one lint job and newest pending
request. Cancel superseded work and discard results after project/profile/context/
buffer-generation changes. Immediately invalidate affected displayed diagnostics.
Pause during user build/simulation/import jobs; lint must not guard project
transitions. Limit engines to 10 seconds and publication to 1,000 findings with
truncation status. Bound completed-job retention, delete copies on all exits,
and keep only the latest lint logs. Probe actual pyslang APIs and Verible; their
absence must not prevent editing or building. No project schema migration.

Implement backend capture/diagnostics, scheduling, editor/Problems, preferences,
and qualification in that order. Acceptance includes unsaved errors/corrections,
widths/ports/names, source groups and ambiguous configurations, defines/DUT
parameters, multiple open headers/external roots/duplicate names/spaces,
Unicode/BOM/CRLF/EOF/macros/notes/ranges, preset/custom rules/waivers/parser limits,
rapid edits and delayed results, switches/cancellation/timeouts/missing tools,
bounded storage, navigation/history, and unchanged source/project/snapshot/run
artifacts. Run Rust/frontend checks, native and Docker browser workflows, and a
packaged Linux editor smoke. Target feedback within two seconds on documented
small fixtures, measuring debounce plus preparation and engines. Record measured
limits in qualification before considering persistent workers.

## Primary documentation

- [Tauri architecture](https://v2.tauri.app/start/)
- [Tauri native dialog plugin](https://v2.tauri.app/plugin/dialog/)
- [CodeMirror language modes](https://github.com/codemirror/legacy-modes)
- [Verilator filelist path semantics](https://verilator.org/guide/latest/exe_verilator.html#cmdoption-F)
- [elkjs](https://github.com/kieler/elkjs)
- [Wellen interfaces](https://docs.rs/wellen/0.25.6/wellen/)
- [Slang elaborator integration](https://github.com/povik/sv-elab)
- [Yosys library mapping](https://yosyshq.readthedocs.io/projects/yosys/en/latest/using_yosys/synthesis/cell_libs.html)
- [Icarus SDF implementation](https://github.com/steveicarus/iverilog/blob/master/vpi/sdf_parse.y)
- [LibreLane PDK configuration](https://librelane.readthedocs.io/en/latest/usage/about_pdks.html)
- [LibreLane step interfaces](https://librelane.readthedocs.io/en/latest/reference/step_config_vars.html)
- [LibreLane compatibility changelog](https://github.com/librelane/librelane/blob/main/Changelog.md)
- [IIC tool image release notes](https://github.com/iic-jku/IIC-OSIC-TOOLS/blob/main/RELEASE_NOTES.md)

- [Slang diagnostics and command-line options](https://sv-lang.com/command-line-ref.html)
- [Verible lint rules, configurations, and waivers](https://github.com/chipsalliance/verible/blob/master/verible/verilog/tools/lint/README.md)
- [CodeMirror diagnostic effects](https://codemirror.net/docs/ref/#lint)
