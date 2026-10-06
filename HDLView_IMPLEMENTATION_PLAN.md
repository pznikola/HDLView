# HDLView implementation specification

Accepted product plan, recorded 6 October 2026. This file is an implementation and continuation specification for another AI agent. It describes the complete intended release; [QUALIFICATION.md](docs/QUALIFICATION.md) records what the current implementation actually demonstrates and what remains unqualified.

## 1. Product and architecture

Build a Linux-first desktop application for small and medium ASIC designs targeting SKY130 and IHP SG13G2. Users must be able to generate source RTL, elaborated RTL, and synthesized/post-layout netlist schematics from VHDL, Verilog, or SystemVerilog; run/import simulations; select signals in both directions; and launch LibreLane and inspect its results.

**Binding rule: each simulation session binds one waveform to one immutable schematic snapshot.** The user chooses a representation before creating the session. Switching representations requires another session. Never carry a waveform automatically between RTL, synthesized, and post-layout views. Even within the same stage, missing dumps must stay unavailable, and similarly named signals must never be substituted.

| Component                | Selection                                                           |
| ------------------------ | ------------------------------------------------------------------- |
| Desktop shell            | Tauri 2                                                             |
| UI                       | React, TypeScript, Vite                                             |
| Application core and CLI | Rust, independent of Tauri                                          |
| Layout                   | elkjs in a Web Worker, layered/orthogonal, deterministic port order |
| Schematic rendering      | Custom SVG                                                          |
| Waveforms                | Wellen VCD/FST/GHW parsing, Canvas rendering, virtualized rows      |
| Compilation              | Yosys, Slang, GHDL                                                  |
| Physical implementation  | LibreLane                                                           |

Do not add a separately hosted application service. Reuse existing HDL parsers, simulators, synthesis, timing, placement/routing, and extraction engines.

Support VHDL projects and Verilog/SystemVerilog projects separately. Mixed-language compilation is deferred. GHDL handles VHDL RTL simulation; Icarus and explicitly selected Verilator handle SV/Verilog RTL. Gate simulation uses the actual exported Verilog netlist. VHDL-origin designs therefore need a separate SV/Verilog gate testbench. Icarus is the SDF backend; Verilator is not.

Physical-design integration configures and launches LibreLane, collects progress/reports/artifacts, and creates a matching post-layout snapshot. Detailed layout viewing stays in external tools.

## 2. Research and reuse

Read [the visualization research](docs/research/rtl_visualization_tools.md) for the
tool survey and inspected upstream revisions. Local reference checkouts are
optional research material and are not required to build or run HDLView.

| Project/group                                   | Reuse decision                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Yosys, GHDL, ghdl-yosys-plugin                  | Core external compilation tools                                                            |
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

- `ProjectConfig`: ordered sources, language/standard/library, includes, defines, top, parameters/generics, simulation configurations, physical configuration.
- `ToolchainProfile`: native/Docker provider, executable/plugin paths, environment, immutable image identity, PDK roots, timeout and capability information.
- `DesignSnapshot`: representation, input/artifact fingerprints, hierarchy, normalized graph, source references, diagnostics and tool identities.
- `SimulationRun`: one bound snapshot, actual simulated inputs, simulator/testbench/DUT scope, trace/dump information, optional models/SDF/corner/delay selection.
- `PhysicalRun`: LibreLane configuration and dependency identity, status, reports, matching output artifacts, and independently preserved signoff outcomes.
- `SignalBinding`: schematic declaration/endpoint, waveform declaration, bit correspondence, resolution status, and matching evidence.

Shareable configuration belongs in `hdlview.project.json`. Machine-specific paths belong in user toolchain settings. Captured inputs and generated artifacts must not overwrite source HDL.

The common runner must use argument arrays, isolated work directories, reproducible command/environment manifests, structured diagnostics, progress/log collection, cancellation, time limits, and atomic publication. Generated Yosys/Tcl/Verilog text needs language-specific escaping. Native cancellation kills the process group; Docker cancellation terminates the container. Parser subprocesses must also be killable.

Docker mounts captured inputs/PDKs read-only and outputs writable. No VNC/desktop or nested Docker is needed. Do not mount the Docker socket inside tool containers. Run LibreLane directly in the selected image.

Cache only when actual input contents, settings, compiler/plugin identities, and relevant PDK/config contents are accounted for. Conservative rebuilding is preferable to unsafe cache reuse. Edits create a new snapshot; old sessions keep their original inputs and trace. Reopening must detect changed artifacts.

## 4. Representations

### Source RTL

Build behavioral/dependency graphs for definitions, instance occurrences, processes, concurrent assignments, operators, and named reads/writes. Preserve source locations, parameters/generics, symbolic generates, and expandable process details. This view explains source behavior; it is not a physical gate claim.

Use isolated pinned `pyslang` syntax/semantic APIs for SV/Verilog and compiler-matched `pyGHDL.libghdl`/DOM APIs for VHDL. Do not reconstruct source behavior from synthesis. Unsupported syntax/type/connectivity must become an explicit diagnostic or opaque node. Never infer invented connectivity from text regexes.

Source and elaborated sessions may simulate their corresponding HDL sources, but compiler-only temporaries without simulator declarations remain unavailable.

### Elaborated RTL

Use Slang/Yosys or GHDL/Yosys. Resolve parameters, generics, widths, generate blocks, and instances, then lower processes into registers/muxes/operators while retaining word operations and memories.

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

Yosys numeric bits are module/snapshot-local. IDs must include snapshot and instance context. Keep path segments losslessly, including escaped identifiers, original spelling, signedness, bit indices, declared offsets and direction. Normalize VHDL case only for ordinary case-insensitive identifiers.

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

Lay out only the current module or bounded neighborhood; automatically limit large views to 2,000 nodes/cells and offer focused exploration. Use deterministic port ordering, orthogonal layered layout, and snapshot-scoped caching. Selection/cursor movement must not request layout.

Waveforms use Wellen outside the UI thread. Query only visible rows/windows, preserve aliases, X/Z/VHDL values, radix, bus bits, integer timestamps/timescale, and pixel-level activity indications. Serialize timestamps as strings. Do not assume every format is demand-loaded; measure indexing time and peak memory independently. Add disk-backed indexing if needed for the supported memory budget.

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
| VHDL RTL                  | GHDL                                             |
| Verilog/SystemVerilog RTL | Icarus or explicitly selected Verilator          |
| Zero-delay Verilog gates  | Icarus; Verilator only after model qualification |
| SDF-annotated gates       | Icarus only                                      |

Keep synthesis and testbench sources separate. Configure testbench top, DUT instance path, parameters, runtime arguments, stop time, dump scope, and expected trace. Instrument only generated run files; never edit user HDL. Testbenches must be simulator-compatible; do not promise automatic translation. Gate testbenches should use named ports because export can reorder declarations.

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

| Milestone          | Completion gate                                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0. Dependencies    | Pin image/tools/libraries; reproduce both PDK mapping tests, frontend hierarchy, GHDL Python compatibility, model compilation, supported SDF features |
| 1. Core            | Project/schema, immutable capture, native/Docker jobs, cancellation, diagnostics, CLI on a small design                                               |
| 2. Linking         | Hierarchical Verilog build/simulation, repeated instances and buses, bidirectional selection                                                          |
| 3. Representations | Source and elaborated views for all language families, specializations, explicit unsupported constructs                                               |
| 4. RTL simulation  | GHDL/Icarus/Verilator jobs and imported VCD/FST/GHW all share binding/session rules                                                                   |
| 5. Gates           | Both PDKs map and simulate exact netlists; stage restrictions and library models verified                                                             |
| 6. Physical        | Each PDK completes a small full flow; final netlist/SDF/layout/reports imported with checker outcomes preserved                                       |
| 7. SDF             | Both PDKs exercise delays/annotation errors/corners; unsupported coverage reported independently                                                      |
| 8. Release         | Performance corpus, restoration, native/Docker parity, Linux package/smoke, examples, notices and documentation                                       |

The early Verilog demonstration is not final scope. Release acceptance additionally requires the documented VHDL/source/gate/physical workflows and qualification corpus.

## 9. Acceptance corpus for continuation

Expand tests using small focused fixtures for repeated instances, parameter/generic specializations, generates, includes/packages/VHDL libraries, registers/latches/muxes/arithmetic/memories/constants/feedback/blackboxes, ascending and descending/nonzero ranges, slices/concatenations/signed values/escaped names, duplicate names/DUT instances, aliases/X/Z/large timestamps/missing dumps/ambiguous roots, changed sources and stage mismatch, and delayed endpoint disagreement.

Validate known testbench assertions and trace transitions. Exercise both PDK model sets, cell/interconnect delays, min/max selection, wrong annotation scope, unsupported timing diagnostics, and exact final-netlist/SDF pairing. Preserve DRC/LVS/STA reports independently.

Exercise paths with spaces, missing plugins/Docker/environment/PDK files, invalid HDL, simulator failure, cancellation and interrupted jobs. Compare native/Docker normalized identity/connectivity for compatible tool versions, not raw generated names.

Use Rust tests, frontend tests, browser interaction tests, and packaged Linux smoke tests. Include real Docker toolchain qualification for releases. Update `docs/QUALIFICATION.md` with evidence, limitations, and failed checks rather than marking broad milestones complete based on one counter example.

## Primary documentation

- [Tauri architecture](https://v2.tauri.app/start/)
- [elkjs](https://github.com/kieler/elkjs)
- [Wellen interfaces](https://docs.rs/wellen/0.25.6/wellen/)
- [GHDL Python binding compatibility](https://ghdl.github.io/ghdl/quick_start/python/index.html)
- [Slang elaborator integration](https://github.com/povik/sv-elab)
- [Yosys library mapping](https://yosyshq.readthedocs.io/projects/yosys/en/latest/using_yosys/synthesis/cell_libs.html)
- [Icarus SDF implementation](https://github.com/steveicarus/iverilog/blob/master/vpi/sdf_parse.y)
- [LibreLane PDK configuration](https://librelane.readthedocs.io/en/latest/usage/about_pdks.html)
- [LibreLane step interfaces](https://librelane.readthedocs.io/en/latest/reference/step_config_vars.html)
- [LibreLane compatibility changelog](https://github.com/librelane/librelane/blob/main/Changelog.md)
- [IIC tool image release notes](https://github.com/iic-jku/IIC-OSIC-TOOLS/blob/main/RELEASE_NOTES.md)
