# HDLView implementation specification

Accepted product plan, recorded 6 October 2026. This file is an implementation and continuation specification for another AI agent. It describes the complete intended release; [QUALIFICATION.md](docs/QUALIFICATION.md) records what the current implementation actually demonstrates and what remains unqualified.

## 1. Product and architecture

Build a Linux-first desktop application for small and medium ASIC designs targeting SKY130 and IHP SG13G2. Users must be able to generate elaborated RTL, mapped-gate and post-layout netlist schematics from Verilog or SystemVerilog; run/import simulations; select signals in both directions; and launch LibreLane and inspect its results.

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

Support Verilog/SystemVerilog projects only. Reject unsupported projects without replacing the current workspace. Icarus and explicitly selected Verilator handle RTL and compatible gate runs. A shared testbench configuration compiles captured RTL or the exact exported Verilog netlist according to the selected snapshot. Icarus is the SDF backend; Verilator is not.

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

The originally supplied image is `hpretl/iic-osic-tools:2025.12`, digest `sha256:92961478ad3c4f508efb42d9ccdba12ab262eb42a14926d2bd49862230ba8521`. Initial research identified Yosys 0.60 with the Slang plugin, Slang 9.1.204, Icarus 13 development, Verilator 5.042, LibreLane 2.4.10, and both PDKs. Basic frontend, mapping, and synthetic SDF feasibility did not establish full flow qualification.

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

Use a **File** menu containing Create New Project, Open Existing Project, New File, Add New Files, Save Project, and Close Project. Keep Project Settings and Toolchain to its left-side command group, followed by the project name; place the logo at the far right. Preserve the second-row stage/build/simulation controls. Commands support keyboard navigation, Escape/outside dismissal, and focus restoration; project-changing commands are unavailable during jobs, with cancellation still accessible.

New Project has Project, Sources, and Review steps: name/directory, fixed Verilog/SystemVerilog language, and SKY130 or IHP SG13G2 technology; independently import source groups; review order/exclusions; then Create New Project. Keep a backend draft and publish configuration only on the final successful action. Cancellation preserves the current workspace and writes no configuration. Clock settings belong in Project Settings before mapped/physical builds. Require explicit revision-checked overwrite for existing configuration.

Reference original files without copying them into the project. Empty projects and unset tops may be saved; separate configuration validation from build readiness. Build requires design sources and a valid, user-entered top. Project Settings uses a categorized dialog: General, Sources, Simulation, Physical Design, and Editor, with a fixed Cancel/Apply/OK footer and responsive navigation. One draft covers every section and survives reviewed simulation-source imports. Apply updates the working project, OK applies and closes, and cancellation discards changes since the last Apply. File → Save Project persists applied changes. Editors retain their history and immutable artifacts remain attached to their snapshots.

Normal controls cover project name/location, design top/standard/technology, ordered sources/includes, defines/parameters, named simulations, clocks, SDC, utilization/density and local lint preferences. Simulation configurations expose simulator, manually entered testbench top/full DUT path, ordered selected simulation units, integer duration/unit, duplication/rename/deletion, and advanced defines/arguments/models/SDF/corner/delay selection. Defaults are an explicitly added `default` configuration, Icarus, 1 µs, current simulation units, and empty top/path. Do not infer HDL names. Optional JSON is limited to uncommon LibreLane overrides and shares the same Apply action. Preserve unrelated configuration and source-root identities.

Rust validates field locations separately from workflow readiness, resolves picker inputs without publishing drafts, and rejects invalid settings through update/save/execution paths. Empty projects remain valid. Show Configure shortcuts for missing setup, including lint ownership, and require rebuilding before using project settings different from a snapshot's recorded fingerprint. Applying settings never compiles or transfers a waveform. Verify no-JSON setup, imports during editing, Apply/OK/Cancel, external inputs, configuration management, SDF restrictions, persistence, keyboard/narrow-window behavior, and native/Docker counter execution.

Project schema **3** is the only project format and is independent of the snapshot/run schema (2). Any other schema version, an unknown field, or a snapshot or run of another schema is rejected with a plain error; there are no migrations. Loading registers configuration testbenches as simulation sources, deduplicates resolved identities, and merges duplicate import records, without writing. Keep only design/simulation import groups, preserving distinct working-directory records. File references are project-relative strings or `{root, path}` objects. Roots may be outside the configuration directory, preferably recorded relatively; paths beneath roots cannot escape them. Apply references to sources, headers, includes, assets, testbenches, models, SDF, and SDC. The `__roots` namespace is reserved for captured copies of external inputs: only a captured project may name it.

Capture resolves roots into separate immutable input namespaces, preserves hierarchy, produces compiler-facing relative paths, and records original-source mappings. External working directories never enter tool containers: Docker compiles read-only captured inputs. Open validates JSON before prompting about current unsaved changes and activating the new project. Restore each project's last valid schematic and matching waveform automatically from machine-local checkpoints keyed by canonical configuration path. Restore default tabs/layout/scope/cursor/zoom/rows. Validate provenance, captured fingerprints, and snapshot/run binding. Missing or corrupt artifacts produce warnings while preserving available sources/schematic; changed working inputs show Rebuild required. Never compile/simulate during opening, and never associate one project's session with another.

Save Project saves edited documents, configuration, and artifact references. Close prompts Save/Discard/Cancel when dirty; failed saves prevent closure. Flush checkpoints before successful transitions, release parser resources, and retain original files/artifacts.

Imports must implement:

- Multiple-file selection; recursive folder discovery of `.v`/`.sv`/`.vh`/`.svh`. Headers are not standalone compilation units and register their containing include directories.
- Separate root labels and preserved directories for duplicate basenames. Deterministic relative-path folder order; filelists retain listed order. Provide move-up/down controls rather than claiming alphabetical order resolves package dependencies. Remove source-panel import/rescan buttons; use File → Add New Files and folder/filelist context actions.
- Skip `.git`, `node_modules`, `target`, `.hdlview`, `dist`, and other generated caches. Do not follow directory symlinks. Report skips in review; explicit selection may add excluded files or select the intended directory.
- Review exclusions and explicit design/header/simulation roles. Accept only Verilog/SystemVerilog. Enforce picker and Rust checks; explicit unsupported files/filelists fail transactionally, while folder scans skip files that are not HDL. Never infer testbenches from names.
- Explicit **Rescan Folder** and **Reimport Filelist** previews. Folder rescans preserve assigned order; filelist reimports apply the reviewed list order. Preserve roles, and preview additions/missing files. Removing an entry never deletes its original file.

Common `.f`/`.flist` syntax includes ordered and quoted paths, comments, nested `-f`/`-F`, `+incdir+`, and `+define+`. Interpret the selected list with `-F` semantics: contents relative to that list's directory. Nested `-f` contents resolve relative to the import working directory, configurable before parsing and in review, defaulting to the selected list's directory. Substitute import-environment variables without shell execution. Undefined variables, list cycles, missing paths, unsupported switches, and conflicting defines are located import errors. Failed imports cannot partially modify a project. Persist expanded configuration plus original import references; do not reread lists implicitly at build time.

### Source explorer and file management

Use a selectable, keyboard-accessible tree for registered Design, Simulation, and Auxiliary entries. Preserve directory/root labels, show file/header/folder icons and dirty/missing indicators, and reveal the active working file. Arrow keys navigate, Enter opens, F2 renames, and Shift+F10 opens context actions. Add New File/New Folder icons to source-group headings and File → New File (Ctrl+N); retain File-menu imports and rescan/reimport context actions. Empty projects remain creatable without source inputs.

New File chooses group, destination, and filename; default to project `rtl/` or `sim/`, or the context folder. Permit external destinations through existing root registration. Create truly empty `.v`/`.sv`/`.vh`/`.svh` files exclusively, register headers/includes separately, append compilation units without guessing a top/testbench configuration, and focus the editor. Create missing default directories only upon confirmation. New Folder registers an empty folder import, visible after saving/reopening, without automatically scanning it.

Rename files/folders within their parent without replacement. Validate names/roles, update all working references and affected import working directories/root locations, and retain buffers and undo history. Include strings and filelist text are not rewritten. Remove from Project previews affected entries/configurations, removes references, preserves named configurations and originals, and records typed file/directory import exclusions. Reviews show exclusions unchecked; explicit re-add is required. Removing a filelist does not remove its expanded design sources. Missing entries remain removable.

Move to Trash previews exact original paths and calls host `/usr/bin/gio trash -- PATH` with argument arrays. Never permanently delete on failure. Inspect all folder contents without symlink traversal; block folder Trash for unregistered files or failed inspection. Protect configuration ancestors, source-root headings, and internal artifacts. Modified working tabs offer Save/Discard/Cancel before removal/Trash; snapshot tabs remain readable.

Rust owns typed create, preview, and apply operations, mutation serialization, candidate validation, stale project/disk rejection, and exclusive publication. Reuse cancellable jobs for inspection and application; once a disk mutation commits, publish its actual result rather than pretending cancellation undid it. Keep optional import exclusions in schema 3, omitted when empty, and reuse folder records for empty directories. File changes dirty project membership, invalidate lint, and preserve immutable snapshots/waveforms. Save Project persists configuration separately; transition prompts explain that Discard does not undo completed disk operations. Do not rewrite old artifact fingerprints or guess a relocated working-source mapping.

Qualification covers creation/cancellation, files/headers/folders/external roots, names/collisions/permissions, rename/reference/history preservation, persistent exclusions, real isolated Trash/failures/blockers, keyboard/focus behavior, native/Docker builds, lint invalidation, immutable sources/bindings, and packaged Linux create/save/close/reopen. No drag/drop, multiple selection, permanent deletion, watchers, templates, or filesystem undo are included.

Use Tauri's official dialog plugin with scoped picker permissions; filesystem operations and parsing stay in Rust core. Expose typed project/settings, preview/application, rescan, document-read, and revision-checked-save service operations. Reuse cancellable jobs for scans and imports.

The common runner must use argument arrays, isolated work directories, reproducible command/environment manifests, structured diagnostics, progress/log collection, cancellation, time limits, and atomic publication. Generated Yosys/Tcl/Verilog text needs language-specific escaping. Native cancellation kills the process group; Docker cancellation terminates the container. Parser subprocesses must also be killable.

Docker mounts captured inputs/PDKs read-only and outputs writable. No VNC/desktop or nested Docker is needed. Do not mount the Docker socket inside tool containers. Run LibreLane directly in the selected image.

Cache only when actual input contents, settings, compiler/plugin identities, and relevant PDK/config contents are accounted for. Conservative rebuilding is preferable to unsafe cache reuse. Edits create a new snapshot; old sessions keep their original inputs and trace. Reopening must detect changed artifacts.

## 4. Representations

There are three representations: elaborated RTL, mapped gates and post-layout gates. RTL simulation compiles the captured HDL sources of an elaborated snapshot; compiler-only temporaries without simulator declarations remain unavailable.

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

The baseline RTLIL and normalized Verilog remain the inputs for synthesis and physical implementation. The drawn netlist is a separately cleaned copy of that RTLIL:

```text
keep every declared wire
opt_expr -mux_undef, opt_clean
opt_dff -keepdc            (asynchronous-load conversion on every register)
opt_dff -keepdc -simple-dffe   (enable/synchronous-reset folding, except through a declared D net)
opt_expr -mux_undef, opt_clean
wreduce -keepdc            (add, subtract and multiply only)
opt_clean
write_json
```

This cleanup may remove compiler-generated cells and wires only. Every declared signal keeps its name and width, registers are never replaced by constants, enable inference adds no logic, comparators keep their declared operand widths, and no cells are merged or shared.

### Mapped and post-layout gates

Gate views always come from a PDK flow; there is no technology-independent gate stage. Use pinned LibreLane synthesis configuration for production PDK mapping, including combinational and sequential mapping, exclusions, and technology mappings. A bare `abc -liberty` feasibility test is not the production PDK flow.

Defaults are `sky130A/sky130_fd_sc_hd` and `ihp-sg13g2/sg13g2_stdcell`. Record the selected corner.

**Import the exact exported Verilog netlist that simulation consumes**, with library interfaces and no optimization/resynthesis. Derive pin directions/labels from library metadata, and symbols and pin roles from the library's own functions (§12). Physical-only filler cells may require interfaces extracted from simulation models because timing libraries omit them. Blackbox interfaces are never simulation models.

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

The left sidebar switches between **Sources**, **Design**, and **Inspector**. Sources is available immediately after opening/creating a project; Design shows compiled hierarchy and Inspector shows current selection details. Selection does not automatically switch the sidebar. Sources groups directories/files under Design Sources, Simulation Sources, and Filelists and Auxiliary Files. Compilation order is a separate settings list. Clicking a source opens an editor tab with root/directory labels distinguishing duplicate basenames.

Place editor and schematic beside each other with a keyboard-accessible adjustable splitter and independent collapse controls. A full-window-width bottom panel switches between Waveforms, Logs and Problems. Sidebar width, editor width and bottom-panel height have keyboard-accessible resize dividers with minimum/maximum constraints. Hidden views retain their state. Resizing preserves selection, cursor/zoom, and schematic layout; virtualized waveform rows follow the visible pane height. Use CodeMirror 6 with minimal extensions and the Verilog stream mode for highlighting, line numbers, indentation, search/replace, history, dirty tabs and document Save. File → Save Project and `Ctrl+Shift+S` save modified files and configuration; `Ctrl+S` saves the active file.

Preserve UTF-8 BOM and line endings; explicitly diagnose unsupported encoding, missing files, and permissions. Compare current content against the opened/saved revision before writing. A conflict retains the buffer and offers Reload, Overwrite, or Cancel. Modified-tab closure, project switching, and desktop closure offer Save/Discard/Cancel; save failures prevent leaving. Building with unsaved changes offers Save All and Build or Cancel. Saved source/config changes mark the displayed design stale without automatic rebuild.

Schematic source navigation opens captured snapshot text read-only at the recorded location. A separate Open Working File action uses original-source mappings. Never apply old snapshot line numbers to edited working files. Existing snapshots and waveform sessions remain immutable.

Lay out only the current module or bounded neighborhood; automatically limit large views to 2,000 nodes/cells and offer focused exploration. Use deterministic port ordering, orthogonal layered layout, and snapshot-scoped caching. Selection/cursor movement must not request layout.

### Professional schematic presentation

Keep the custom React/SVG renderer and pinned ELK worker. Rust owns symbol classification,
pin roles, grouping and connectivity; TypeScript owns original SVG
geometry, colors, text dimensions, camera and interaction. Geometry definitions supply
both drawing paths and fixed layout anchors. Retain raw compiler parameters for widths,
signedness, clock/reset polarity/values and memory dimensions.

Provide curved AND/OR/XOR and inverted gates, buffers/inverters/tri-state enables,
trapezoid mux/demux/decoder/encoder symbols, clocked D/Q registers/latches, arithmetic,
comparison/shift/reduction operators, memories, directional input/output/inout ports,
hierarchy blocks, constants and bus taps/joins.
Unknown types and incompatible library interfaces remain explicit labeled boxes.
Distinguish binary, bitwise and one-hot mux semantics, including undefined multiple
one-hot selection. Show sequential polarity and synchronous/asynchronous reset details;
nothing is inferred from signal names.

Conservatively recognize complete uniform binary mux trees, full comparison-bank decoders
and constant-code priority encoders in elaborated RTL. Keep original widths, constants,
selects, defaults and priority, and reject conflicting drivers or externally consumed
intermediate outputs. Groups reference original nodes/pins and open their original
structure. Compiler-node display disables grouping. Mapped and post-layout cells remain
individual exact instances from the exported simulation netlist, drawn from their
Liberty-derived functions (§12); expose drive variants and power details in inspection. Hide only positively identified fillers, taps
and decoupling cells, with explicit counts and reveal controls.

Use left-to-right orthogonal layout, directional boundary constraints, fixed data/control
anchors, deterministic ordering and space for feedback; §12 defines the current net,
ordering and label rules. Convert
fan-out to supported simple routes with original-net mappings; represent multiple-driver
and inout connectivity through explicit junctions, without Cartesian expansion. Draw
junction dots only at real connections. Bundle buses, preserve ordered slice correspondence,
and render constants near consumers. Distinguish off-view connectivity from undriven nets.
Prefer declared user labels; keep compiler names in inspection/tooltips. Zoom suppresses
secondary labels while exports retain them.

Display offers light/dark canvas (light default), compiler nodes, full clock/reset wiring,
physical cells and grid (off default). Clock/reset connectors require validated semantic
roles and exact net identity; mixed data/control nets remain wired. Preferences stay local
and outside compilation fingerprints. Selection, theme and cursor changes do not lay out.
Cache by snapshot-scoped graph/metadata, semantic view options and geometry version.
Pins retain their original identities, including separate delayed gate endpoints. Waveform
selection reveals an internal grouped signal through its detail view; clicking a symbol
inspects its object/pins. Export standalone SVG with chosen theme/styles and required
labels, excluding interaction/selection overlays.

Qualification includes counter and mixed ALU/decoder/encoder/memory/hierarchy fixtures,
both PDKs, group details, all glyph families, bus constants/slices,
feedback/inouts/multiple drivers, grouped cross-probing, themes and export. Use semantic
and routing tests, a reviewed symbol gallery, real native/Docker browser workflows and a
packaged Linux schematic/export smoke. Measure mixed/high-fan-out 1,000-node layouts and
loaded selection feedback against the existing targets; reuse physical artifacts rather
than rerunning unrelated implementation flows.

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
| Zero-delay mapped gates   | Icarus; Verilator only after model qualification |
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
| 3. Representations | Elaborated views for Verilog/SystemVerilog, specializations, explicit unsupported constructs                               |
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

Project-lifecycle acceptance additionally covers cancelled drafts without writes, both technology presets, grouped imports through all methods, backend language-policy bypass attempts, shared testbench reuse, rejection of other project schemas and unsupported files, menu/context keyboard behavior, and independent automatic restoration of two projects. Verify missing/corrupt/stale/mismatched artifacts, saved-original conflicts and failed transitions, job cancellation, and packaged Linux menu/native-picker/reopening behavior. No full UI-layout restoration, recent-project menu, extra top-level menus, or unsaved-buffer recovery is included in this amendment.

## 10. Live editor linting amendment

Analyze working design/testbench files, including unsaved buffers, independently
of displayed schematics and waveforms. Use pinned pyslang 10.0.0 for preprocessing,
syntax and semantic diagnostics, and the tool image's Verible
`v0.0-3724-gdec56671` for configurable style. Defer Verilator lint, LSP, formatting,
and autofix. Pin CodeMirror lint 6.9.5 and retain actual dependency notices.

Run after 750 ms without typing and after working-file open/save/reload, context
or relevant settings changes, and application focus. Exclude captured and auxiliary
tabs. Show red/yellow underlines, gutter markers, engine/code hover messages,
Problems in the shared bottom panel, clickable ranges/related locations, and F8/Shift+F8.
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

## 11. Schematic clarity and workspace amendment

Keep the shared SVG/ELK renderer and schema 3. Align compact 24-unit boundary
port glyphs in input/output columns, with inputs left and outputs/inouts
right; §12 defines their vertical order and the pin sides. Preserve compiler
declaration order of instance pins in new Yosys builds and declared bus
range order in expanded views without changing bit identities or old artifacts.
All routing anchors must equal the drawn terminals on every side; center side
labels on their connection lines. Increment the geometry/cache version for these
changes.

Use persistent four-unit square terminals for pins and round dots for true
electrical branch junctions. Normalize/deduplicate routes only within an exact
net/slice, retain original edge mappings, validate ELK junction hints, and never
join foreign crossings or procedural edges. Wire hit strokes stay eight screen
pixels; only pin terminals/labels activate pins. Typed presentation selections
keep exact endpoint identities and lighter connected-wire context. Keyboard,
hover, focus, tooltips, cross-probing and missing-binding behavior remain available
without layout work. Exports keep corrected geometry/junctions but omit hit
regions, transient highlights and grid.

Transform the grid with the schematic camera. Use 24-unit world spacing and
powers-of-four coarser levels when the projected spacing falls below eight pixels;
all levels share the world origin. Themes/grid remain local presentation settings.

Prefer a valid expected trace.vcd after simulation. If absent, inspect only VCD/FST
files in that newly created run directory using Wellen headers and exact DUT
scope. Skip symlinks, reject escaping paths, accept exactly one qualifying trace,
and record its actual path/hash in run provenance. Multiple, missing, malformed
or wrong-scope traces are explicit errors; never search original sources/old runs.
Generated instrumentation continues to leave user HDL untouched.

Use one Sources/Design/Inspector sidebar on the left, with editor/schematic beside
it. Put Waveforms, Logs and Problems in a single full-window-width tabbed panel
below both areas. Keep the selected sidebar view when selecting a schematic object.
A successful simulation opens Waveforms. Keep inactive views mounted so tabs,
collapse and resizing preserve editor history, explorer expansion, camera,
waveform rows/cursor/zoom/radix and independent scroll positions. Pause hidden
waveform queries. The sidebar defaults to 260 pixels within 224–420 pixels, leaving
at least 360 pixels beside it on supported windows. The bottom panel defaults to
35%, at least 140 pixels, at most 65%, and leaves at least 260 pixels above. Resize
handles support pointer capture and keyboard arrows/Home/End. The editor/schematic
split stays within 20–80%, with 200/320-pixel minimums when space permits; window shrinking
clamps effective sizes. Presentation changes must not request graph layout.
Reopening uses default pane sizes, consistent with existing restoration behavior.

Acceptance covers unused/disconnected boundary ports, inouts/range directions,
all symbol anchors/long labels, shared trunks/multiple drivers/foreign crossings,
pin versus wire selection/keyboard/SDF identities, both grid themes/camera/coarse
levels, testbench-named traces with Icarus/Verilator and rejection paths, shared
sidebar views, full-width panel tabs, resizing, independent scrolling, narrow
windows and state preservation, native/Docker browser workflows,
packaged Linux smoke and existing layout/selection performance targets. Update
qualification with measured results and limitations; no new dependencies, migration
or full physical-flow rerun is required.

## 12. Quartus-style schematic amendment

Recorded 9 October 2026. Where this section differs from §6 and §11, it replaces them.
Project schema 3 and the snapshot schema are unchanged; every new view field is optional.

**Nets.** Form one net per set of drivers, so a bus stays whole however its bits fan
out. Every input pin carries ordered `feeds` covering it exactly: a run of a net with
the slice or replication it takes (`[5:0]`, `[2] ×8`, empty for the whole driver), a
constant literal, or an undriven run. Constants and undriven inputs are drawn on the
pin, never as shared nodes. Output bits nothing reads draw nothing. A bounded view ends
each cut bus in one connector. A pin assembled from several sources gets one join that
lists its ranges from the most significant down. A net is named by a declaration only
when that declaration names every one of its bits; its width is not part of the name.
Rust computes all of this; the frontend never infers a slice or constant.

**Layout.** Each boundary port is its own layout node in a separate first or last
layer, with terminals aligned per side. Vertical order within a column follows the
logic to reduce crossings; it is not the declaration order, and ports without a drawn
wire only follow declaration order as a hint. Order nodes so that every wire runs
forward except the outputs of registers, latches and memories that close a loop, and
have the layout engine reverse exactly those: a register sits after the logic that
computes its input. Electrical nets reserve no label space. A net name is drawn on the
straight run leaving its single driver only when that run has room, no wire crosses the
name, and the driver does not already show it; names remain in tooltips and inspection.
Views above 400 nodes use longest-path layering with Brandes–Köpf placement.

**Symbols.** Synchronous inputs enter on the left with the data: clock, enable, select
and synchronous reset. Outputs leave on the right. Only asynchronous clear and load
enter from below and asynchronous preset from above; a tri-state enable meets the lower
edge of its buffer. Rust marks asynchronous pins; the frontend never chooses a side
from a pin name. A register or latch is named after the declared net or slice its Q
drives, and D and Q share a row. All symbols share a 20-unit pin pitch. Logic gates
show no data pin names; boxes label bus pins with their range; a bus leaving any other
symbol carries a slash and its width. A two-way multiplexer labels its inputs `0` and
`1`. A long name may widen its symbol by at most 48 units and is shortened beyond that.
Annotations appear in tooltips and inspection, not on the canvas.

**Case multiplexers and controls.** Draw a `$pmux` with one data and one select pin
per case, and a memory with one pin per port. When every select of a `$pmux` is driven
only by a comparison of one common signal with a distinct constant, and each comparison
feeds nothing else, fold the multiplexer and its comparisons into one `MUX n:1` selected
by that signal, with data inputs named by case value and an undefined default omitted.
The fold is a presentation group like the others: its members stay inspectable and it
is rejected rather than approximated when a comparison is shared. A module instance pin
is a clock, or a reset, exactly when every pin it reaches inside the child is one,
followed through nested instances; such nets may be drawn as control connectors. Memory
controls tied to the constant that disables them (an unclocked read port's clock, an
always-on read enable, a reset tied low) are inspected but not drawn.

**Library cells.** A mapped or post-layout build also reads the mapped Liberty library
as logic (`read_liberty` without `-lib`) and decodes each cell from that gate network,
never from its name: AND, OR, NAND, NOR, XOR and XNOR with inverted inputs drawn as
bubbles and the fewest bubbles preferred; buffers, inverters and tri-state drivers;
two- and four-way multiplexers; AND-OR and OR-AND cells of any grouping with their
internal gates drawn; registers and latches whose clock, enable, reset and set are the
library pins that reach the storage element directly or through one inverter. The
result is stored per library module as its function, and is the only source of gate
symbols and pin roles: there is no table of cell names. A library cell with supply pins
only, such as a fill or tap cell absent from Liberty, is physical by its interface. A
cell the decoder cannot describe exactly, or an instance with a pin the function does
not know, stays an explicit labelled box. A build whose library cannot be read fails.

Qualification adds relational layout checks over hand-written graphs (no overlap, no
wire through a foreign symbol, aligned columns, registers right of their input logic),
bend, crossing, wire-length and area figures in the layout benchmark, and per-exercise
cell, pseudo-node, unknown-symbol and declared-signal counts. Coordinates are still not
asserted.

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

## 13. Representation and format reduction (2026-10-09)

Owner decisions that supersede earlier text wherever they conflict:

- The Source RTL (behaviour/dependency) and Generic gates (technology-independent
  synthesis) representations are removed. The stages are Elaborated RTL, Mapped gates and
  Post-layout. Gate-level simulation therefore always needs a PDK flow.
- No compatibility paths. Project schema 3 and snapshot/run schema 2 are the only
  formats; earlier projects, snapshots and runs are rejected and must be recreated or
  rebuilt. Fields that every writer produces are required when reading.
- Gate symbols come only from Liberty-derived functions (§12).
- A Docker toolchain profile must name its image; there is no built-in default image.
