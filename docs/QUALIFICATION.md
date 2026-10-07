# Qualification — 7 October 2026

This file records exercised workflows separately from proposed release targets. Version 0.1.0 is an engineering preview; it is not a claim of complete HDL-language coverage or signoff-quality timing simulation.

## Bundled SystemVerilog exercises

The public examples now contain exercises `00_mux` through `17_afifo`, with 50
required RTL/package/testbench files and 18 portable schema-3 configurations.
The configurations use the original Makefile parameter/define defaults, Icarus,
and a 2 µs limit. No physical constraints or machine-specific tool paths are added.
The counter, Verilog range and schematic showcase fixtures moved to
`tests/fixtures/`; their contents remain byte-for-byte unchanged.

- All **72 source/elaborated workflows** pass through the actual HDLView CLI:
  18 projects × two representations × native/Docker providers. Checks include
  graph endpoint connectivity, simulation snapshot/stage binding, testbench
  assertion output, Wellen waveform parsing, exact DUT scope and trace provenance.
  All testbenches finish before the harness limit.
- **12 binding checks** cover the mux, hierarchical ALU and asynchronous FIFO
  in both representations and providers. Their public ports have exact bindings;
  compiler-only/generated internal signals retain explicit unavailable statuses.
- The native tools are Yosys **0.62+9**, pyslang **10.0.0** and Icarus **13.0
  development build**. Docker uses `hdlview-tools:2025.12`, image
  `sha256:26f11a10c89c2e5416a57ff73ec7f514fc2204d35078da46517bb1461bc2cc0d`,
  with Yosys **0.60**, pyslang **10.0.0** and Icarus **13.0 development build**.
- Hash checks confirm the external originals are unchanged. The copied
  `15_sync_ff` testbench alone seeds its expected-value queue with the reset
  value, preventing an empty-queue startup comparison. Its **101 checks pass**
  in both providers and representations without disabling assertions.
- All **17 browser regressions pass with each provider** after relocation,
  and `tools/qualify.py --schematics` passes **38 native checks** using the
  retained fixtures. Frontend ESLint, formatting, TypeScript and **40 unit tests**
  pass. Python tooling syntax and final source/fixture hash checks also pass.

Source views explicitly report opaque generate-instance arrays in exercises
04, 05, 07 and 08, and memory aggregates in 11, 16 and 17. Elaborated views
resolve their circuit structure. The existing generated-hierarchy binding
limitation described below remains; no name guessing is introduced.
This qualification does not claim gate/physical compatibility for every exercise,
and no physical flows were rerun. Local reports are
`.hdlview/examples/{native,docker}-results.json` and `.hdlview/examples/bindings.json`.

## Schematic clarity and workspace qualification

Geometry version 3 uses compact boundary columns, centered side labels, shared
border anchors and square pin terminals. Electrical routes are normalized only
within original net/slice identities; round dots indicate actual branches, not
bends, terminals or unrelated crossings. The camera transforms both grid spacing
and origin; pin/wire selection remains presentation state. Sources, Design and
Inspector share the left sidebar. Waveforms, Logs and Problems share one full-width
bottom panel with independent scrolling and constrained, keyboard-accessible
resize handles.

- **77 Rust tests** (66 core, 11 identity) and **40 frontend tests** pass; workspace
  formatting/Clippy with denied warnings, frontend formatting/ESLint/TypeScript
  and production compilation pass. Coverage includes compiler port order,
  ascending/descending nonzero bus ranges with unchanged bit IDs, actual ELK
  endpoints for every symbol family, disconnected columns/inouts, shared trunks,
  multiple-driver junctions and foreign crossings. Missing, malformed, wrong-scope,
  ambiguous and symlinked trace candidates fail safely.
- All **17 browser workflows pass with each provider**, native and Docker, including reviewed light/dark gallery
  fixtures, camera-relative grid pan/zoom/Fit/coarse levels, exact terminal versus
  wire/keyboard selection, exports without hits/grid, both simulators with named
  traces, shared sidebar views, full-width panel tabs, independent scrolling,
  pointer/keyboard size limits, narrow windows and preserved camera/editor/waveform
  state. Inspector changes only when explicitly selected.
  Loaded grouped selection measured **38–56 ms**, including click/assertion overhead;
  worker instrumentation confirms presentation changes do not start layout.
- A temporary copy of the reported `04_adder_N` project builds and simulates with
  Icarus 13 and Verilator **5.045 native / 5.042 Docker**. All four runs collect
  the testbench's `adder_N.vcd`, verify `hdlview_sim.adder_N_tb.i_adder_N`, and
  record its actual path/hash in run and manifest. Traces contain **63 Icarus /
  55 Verilator variables**, ending at **102,000 ps**. Hash checks confirm the
  original external sources/configuration were unchanged. Local evidence:
  `.hdlview/clarity-adder-{native,docker}.json`. A native Icarus testbench-named
  `counter.fst` also collects successfully with **20 variables / 132,000 ps**;
  `.hdlview/clarity/fst.json` records the actual path/hash.
- Real Chromium worker benchmarks on the documented workstation measured
  **1,945.6 ms mixed symbols** and **1,813.4 ms high fan-out** for 1,000 nodes /
  999 edges, including the new normalization step. These satisfy the three-second
  fixture target, not a guarantee for arbitrary routing. Raw results remain in
  `.hdlview/benchmarks/layout-result.json`.

The production Debian package passes CLI trace parsing, runtime dependency resolution,
and an isolated 11.27-second startup with empty stderr. A native GTK picker in the
packaged application reopens the adder snapshot and its matching testbench-named
trace. The desktop smoke covers the working testbench editor, shared Inspector
with an exact root-level `b_i` binding, all three bottom-panel views, pointer and
keyboard resizing, and the 1000×650 minimum window. Switching panels retains cursor
23,800 and range 0–51,000. Native SVG export contains 75 square terminals in 73,623
bytes and excludes hit regions, selection, grid and hover/focus rules. Local evidence:
`.hdlview/package-smoke-results.json` and
`.hdlview/clarity/workspace-desktop-smoke.json`. Final size-limit regressions also
pass with both providers after the full suites.

Generated adder instances still expose an existing binding limitation: Yosys stores
`gen_full_adders[0].i_full_adder` as one hierarchy segment, while the trace uses
separate scope segments. Those internal endpoints remain unavailable rather than
being guessed; root-level bindings and collected waveform data are valid.

A feasibility run using a cache directory containing spaces exposed Verilator's
GNU Make restriction on build-directory spaces. The actual adder and browser
qualification use space-free artifact caches, while working projects may reside
in paths containing spaces and are captured normally. This change does not
introduce a Verilator build-directory workaround. No physical flow was rerun and
no project/artifact schema or dependency was changed.

## Professional schematics qualification

The renderer now shares original SVG geometry and fixed anchors with the ELK worker.
Raw cell parameters, optional captured behavior and display metadata are additive;
project schema remains 3. Unsupported source constructs/library interfaces stay explicit.
The reviewed light/dark gallery covers 30 examples of logic, selectors, sequential,
operator, memory, behavioral, hierarchy, unknown, directional-port and constant symbols.
No new dependency or copied reference skin is distributed.

Repeatable checks: run the Rust/frontend commands in README, the browser suite with a
qualified native/Docker profile, and `tools/qualify.py --schematics` (`--mapped` for PDKs).
The latter checks symbol families, captured sequencing/calls/targets, endpoint connectivity
and real testbench results. Source memory aggregates can still be opaque; elaborated
memory interfaces use compiler metadata. Recognition is intentionally bounded: binary
mux trees up to 63 members, decoder inputs up to five bits and complete constant-code
priority chains. No recognition is applied across mapped gate instances.

- **73 Rust tests** and **37 frontend tests** pass, including legacy optional metadata,
  polarity, exact cell interfaces, bus/routing identity, bounded views, grouping and atomic
  SVG publication. Rust formatting/Clippy, frontend formatting/ESLint/TypeScript and
  production compilation pass.
- All **16 browser workflows** passed with native and Docker providers across the
  qualification runs, including the two reviewed symbol-gallery images. Actual tool-backed
  checks covered source detail and call navigation, parent camera restoration, compiler
  nodes, theme/export, unchanged bindings, and waveform selection into a collapsed mux tree.
  A concurrent Docker run exceeded the existing five-second file-creation layout wait;
  that test passed after adopting the normal 40-second tool/layout timeout.
- `tools/qualify.py --schematics` completed **38 native checks** and **46 Docker checks**
  with `--mapped`, including exact exported netlist simulation for SKY130 and IHP.
  The counter, Verilog and mixed showcase fixtures built and simulated successfully.
  Existing SKY130 post-layout artifacts reopen without changing their bytes/hashes;
  **213 physical-only cells** are hidden by classification. No full physical flow was
  rerun. The available historical IHP physical example is VHDL and remains unsupported;
  it is not evidence of current IHP post-layout qualification.
- The Debian package passes CLI waveform parsing, runtime dependency resolution and
  isolated desktop startup with no stderr. An interactive host smoke exercised native
  project selection, Docker elaboration/simulation, hierarchy navigation, both schematic
  themes, native SVG saving, and close/reopen restoration. Standalone exports were parsed
  as XML and checked for embedded styles and absence of transient selection/hit overlays.
  Generated package/smoke evidence remains under ignored `.hdlview/` and `target/`.
- On this Linux workstation (Ryzen 5 5600H, 12 logical CPUs, approximately 16 GB RAM,
  SSD, kernel 6.8.0), a real Chromium worker laid out **1,000 nodes / 999 edges** in
  **1,842.4 ms** for mixed symbols and **1,582.0 ms** for high fan-out. Loaded grouped
  selection measured **30–52 ms**, including Playwright click/assertion overhead; worker
  instrumentation confirmed selection/theme/cursor changes did not start layout.
  These are fixture measurements, not guarantees for arbitrary routing or full
  Tauri-to-screen latency. Raw layout results are in `.hdlview/benchmarks/layout-result.json`.

## Source explorer and file management qualification

The registered-entry explorer and working-file operations were exercised using
real temporary projects. File creation, rename, and Trash modify originals
immediately; project membership is published only by Save Project. Import
exclusions remain optional schema-3 metadata, omitted when empty; historical
snapshot/run files are not rewritten.

- **56 Rust tests** and **28 frontend tests** pass. Workspace formatting,
  desktop-inclusive Clippy with warnings denied, frontend formatting, ESLint,
  TypeScript, and production build pass. Core coverage includes empty/header/
  external creation, collisions and symlinks, stale project/disk previews,
  reference/order preservation, discovered-header tab mappings, missing-entry
  removal, folder/filelist exclusions, hidden Trash blockers, and bounded file-job
  retention.
- **All ten browser workflows pass with each provider**, native and Docker.
  Two focused workflows also pass with each provider after extending successful
  folder Trash and delayed-read coverage. They create/edit/build new RTL,
  preserve dirty buffers and undo history through rename, reuse former filenames
  without tab collisions, reject reads that complete after rename, cancel dirty-tab
  removal, persist empty folders, reopen saved projects, remove membership without deleting originals,
  and move registered files and nested folders to real isolated Trash. Existing
  editor conflicts, legacy loading, imports/rescans, live lint, immutable source,
  cross-probing, shared testbenches, and per-project restoration regressions pass.
  Browser pickers are injected; core filesystem and tool operations are real.
- The rebuilt Debian package passes CLI/runtime checks and an actual
  **native-picker/WebKit smoke on Xvfb**: create an empty SKY130 project, create
  an empty file with Ctrl+N, edit/save it, rename with F2, use Shift+F10 context
  actions, register an empty folder, Save Project, Close Project, and reopen
  through the JSON picker. The renamed source and empty folder remain available.
  Its declared dependencies include `libglib2.0-bin`. Local evidence:
  `.hdlview/source-files-desktop-results.json` and
  `/tmp/hdlview-files-desktop-smoke/` screenshots/logs.

GIO refused Trash on this host's separately mounted `/tmp` filesystem with
“Trashing on system internal mounts is not supported”; the failed operation left
the original and project membership intact. Successful Trash fixtures therefore
use the project filesystem and a separate `XDG_DATA_HOME`, without touching the
user's Trash. Mount-specific Trash availability remains a host limitation;
there is no permanent-delete fallback. The packaged smoke uses the documented
software-rendering/Unix-volume-monitor compatibility settings. These results
qualify this host, not every Linux distribution. No unrelated physical flows or
large-project explorer benchmarks were rerun.

## Live editor linting qualification

The live editor uses pinned pyslang **10.0.0**, Verible
**v0.0-3724-gdec56671**, and CodeMirror lint **6.9.5**. Both tools were exercised
through the normal core/service runner, using actual temporary projects and
unsaved buffers rather than mocked diagnostic responses.

- **45 Rust tests** and **24 frontend tests** pass. Rust formatting and
  desktop-inclusive release Clippy/tests pass with warnings denied, alongside the
  host core/CLI checks; frontend formatting, lint, TypeScript, and
  production build pass. Added cases cover Unicode/EOF ranges, engine timeout
  cleanup, bounded lint-job retention, background cancellation during close and
  user jobs, and HDL-only temporary include capture.
- **23 real-tool checks pass for each provider**, native and Docker. They cover
  syntax, unresolved names, ports, widths, BOM/CRLF, multiple unsaved headers,
  macro definition/expansion locations, external roots and duplicate basenames,
  configuration defines/DUT parameters, limited analysis, custom rules/waivers,
  unsupported style parsing, auxiliary/unregistered-unit exclusion, malformed rules, independently missing engines,
  1,000-diagnostic truncation, and correction without saving. Every check verifies
  unchanged original sources/configuration, removed temporary inputs, and only
  one retained lint job. Reports: `.hdlview/lint-native/results.json` and
  `.hdlview/lint-docker/results.json`.
- **All eight browser workflows pass with each provider**, preserving project
  imports/conflicts/restoration, immutable captured sources, instance/bus selection,
  stage binding, and shared testbenches across RTL/gates. The editor workflow checks
  unsaved underlines, Problems navigation, F8/Shift+F8, simultaneous headers,
  configuration changes, local settings across reopening, immediate invalidation,
  and rejection of a deliberately delayed real-tool result. Focused reruns
  additionally verify undo/redo after diagnostics. Pickers are injected in browser
  tests; backend operations use real files.
- The rebuilt Linux Debian package passes runtime/CLI startup checks and an actual
  **native-picker/WebKit editor smoke on Xvfb**. Its working editor displays semantic
  and style underlines/gutter markers, opens Problems, navigates ranges, corrects
  errors without saving, and discards the dirty buffer during Close Project.
  Originals/configuration remain unchanged, no snapshots are created, and lint
  temporary copies are removed. Local evidence:
  `.hdlview/editor-lint-desktop-results.json`, `.hdlview/package-smoke-results.json`,
  and `/tmp/hdlview-lint-smoke/` screenshots. This qualifies this host, not every
  Linux distribution. No unrelated physical flows were rerun.

On the workstation described below, a four-line design, included header, and one
testbench with two configurations produced browser feedback in **1.95 seconds
native** and **1.93 seconds Docker**, measured from replacement interaction through
visible error underlines, including the 750 ms debounce and preparation. Typical
backend requests including both engines took **0.18 seconds native** and **0.61
seconds Docker**. The 1,010-style-finding cap case took 0.73/1.16 seconds. These are
small-fixture observations alongside other development, not percentiles or large-
project guarantees; larger working-project capture/parsing remains to be measured
before introducing persistent workers.

Slang 10 accepts SystemVerilog-2017/2023 but not Icarus's 2012 dialect. Icarus
contexts therefore explicitly show limited analysis; simulator compilation is
authoritative. Unreferenced headers receive style checks with limited status,
and Verible parser limitations never become duplicate syntax errors or a clean
style result. Live inputs are `.v`/`.sv` and `.vh`/`.svh`; generated models/SDF and
captured tabs are excluded. Timed-out/missing engines are failures independent of
HDL diagnostics. The package builder initially lacked Clippy and its standalone
test invocation lacked the registry mount; verification reuses the host's matching
installed Clippy and registry read-only rather than changing the tool image.

A follow-up restoration regression reproduced a snapshot's old Docker image with
pyslang 9.1.0 overriding the configured image containing 10.0.0. Opening/building
a snapshot now preserves the configured profile for lint and new builds; existing
snapshot simulations retain their recorded profile. Native and Docker browser
regressions pass for profile preservation, unsaved undeclared identifiers, missing
semicolons, visible error markers, engine unavailability, and recovery. All 45 Rust
tests, desktop-inclusive Clippy, and the frontend checks/24 tests pass. The old
image also verifies the actionable version-mismatch message. The packaged smoke
above predates this follow-up; the package was not rebuilt for this fix.

The status-wording follow-up passes frontend formatting, lint, TypeScript,
production build, and **26 frontend tests**, plus the live editor browser workflow
with both native and Docker tools. It distinguishes incomplete/unavailable style
checks from semantic restrictions while retaining syntax errors and navigation.
This frontend change did not rerun Rust or packaged smoke checks.

## Linux compatibility launch

`npm run desktop:compat` was exercised with WebKitGTK 2.50.4 and GTK 3.24.33
in an isolated Xvfb session, with a separate development port and machine settings.
Actual Tauri startup, native JSON selection/cancellation, editor lint, Docker
elaboration/Icarus simulation, SVG schematics, and Canvas waveforms passed with
**zero EGL or GTK warnings**. The original renderer configuration reproduced EGL
warnings; using the default mount monitor reproduced GTK free-space warnings when
a short-lived Docker container started.

The compatibility launch uses Mesa software rendering and GIO's Unix volume monitor
as development troubleshooting options. CPU cost and desktop-managed volume
listing may differ; no graphics-performance benchmark or new package build was
performed. Evidence: `.hdlview/desktop-compat-smoke-results.json` and
`/tmp/hdlview-warning-smoke/` logs/screenshots. Repository formatting checks pass.

## Verilog/SystemVerilog-only qualification

The current project contract is schema 3. Schema-1/2 Verilog/SystemVerilog projects load through an in-memory migration, preserving their files until explicit Save Project. VHDL configurations and GHDL simulators are rejected; source imports accept `.v`/`.sv` and `.vh`/`.svh`. The application supports VCD/FST and explicitly rejects GHW, including renamed GHW files.

- **39 Rust tests** pass, with workspace formatting and Clippy (`-D warnings`). Coverage includes legacy-source merging, canonical identity deduplication, preserved configuration-specific testbench order, transactional import failure, immutable legacy artifact restoration, revision checks, and SDF restrictions before job launch.
- **20 frontend tests** pass, including ordinary configuration availability across representations and SDF eligibility against the actual loaded snapshot. Frontend lint, TypeScript, and production build pass.
- **Seven browser workflows pass with each provider**, native and Docker. They use real temporary files and CLI operations; native picker selection is injected. Coverage includes creation/import/editor conflicts, ordered filelists, legacy migration, cancelled/failed opening, two-project restoration, source/snapshot immutability, instance/bus cross-probing, and one unchanged testbench/configuration across RTL and generic gates.
- The repeatable native matrix has **20 successful results**: source/elaborated/generic builds, shared Icarus testbenches, waveform parsing for both supplied language examples, and Verilator RTL simulation. The Docker `--mapped` matrix has **26 successful results**, adding SKY130 and IHP mapped builds and gate simulations with that same counter testbench. Local reports are `.hdlview/qualification-sv-native/results.json` and `.hdlview/qualification/results.json`.
- An existing Verilog/SystemVerilog SKY130 post-layout snapshot was reopened without changing its captured artifacts and simulated with its matching SDF. Icarus's unsupported timing-check warnings remain visible. No full physical flow was rerun for this change; the old IHP post-layout fixture is VHDL and is intentionally unsupported.

Qualification initially exposed pyslang 9.1's missing Verilog-2005 support. Both isolated helpers were requalified with pyslang 10.0.0, including model-interface extraction for both PDKs. An initial native retry used a Python-3.13 wheel with Python 3.10; installing the matching wheel in an isolated temporary directory fixed that test setup. The final matrices above contain the successful reruns.

Folder rescans preserve assigned roles and order. Filelist/capture/editor tests retain external-root hierarchy, duplicate basenames, skipped caches/symlinks, headers, BOM/CRLF, environment substitution, located errors, cycles, cancellation, and failed writes. These small workflows do not qualify every language or library feature.

The rebuilt Debian application also passed a native create/save/close/reopen smoke test on this host's isolated Xvfb display. The actual GTK directory and RTL/JSON pickers created a SKY130 project, imported a SystemVerilog working source, opened it in CodeMirror, saved an edit with Save Project, cleared the workspace on Close Project, and reopened the schema-3 configuration with its source hierarchy and default editor state. Browser tests above cover the corresponding schematic/waveform restoration paths. The smoke used isolated machine settings and `WEBKIT_DISABLE_DMABUF_RENDERER=1`; EGL warnings remain nonfatal.

The waveform-height amendment passed all seven native browser workflows, followed by a focused regression checking dragging in both directions. The tests cover pointer capture outside the divider, keyboard limits, visible-row growth, preserved cursor/selection, unchanged schematic view/layout work, minimum-window sizing, and default sizing after reopening. Frontend lint, formatting, TypeScript/production build, and 20 unit tests pass. This frontend change did not rerun physical flows or package qualification.

## Earlier qualification evidence

The following results predate removal of VHDL and the split simulation groups. They remain historical evidence, not current VHDL support claims.

The earlier Docker matrix exercised 36 results including VHDL/GHW and a successful retry after fixing Verilator's writable cache directory. [Historical raw results](qualification-results.json) retain the initial failure. Both SKY130 and IHP completed all 80 LibreLane Classic stages and produced final netlists, SDFs, GDS, timing data, and reports. SKY130 had no deferred checker errors. **IHP reported eight Magic DRC violations**, while KLayout DRC reported zero and LVS/setup/hold checks passed; its physical run was marked `failed_checks`.

Zero-delay and SDF-annotated simulation of those final netlists passed named-port testbenches. Measured first-output delay was 1.187 ns for SKY130 and 0.407 ns for IHP. [Historical SDF measurements](sdf-delay-results.json). Icarus reported unsupported `TIMINGCHECK`, and IHP additionally unsupported conditional `COND` delays. Passing the testbench does not establish full timing verification or annotation coverage.

Earlier Debian-package smoke tests exercised the actual GTK picker, CodeMirror editing, Ctrl+S, close Save/Cancel prompts, automatic schematic/waveform restoration, and changed-input rebuild warnings under an isolated Xvfb display. The release targets Ubuntu 22.04-compatible glibc and requires WebKitGTK 4.1. Startup used `WEBKIT_DISABLE_DMABUF_RENDERER=1`; nonfatal EGL warnings persist on this host. These tests do not qualify every Linux distribution or native picker interaction.

## Toolchain qualification findings

The base `hpretl/iic-osic-tools:2025.12` image is pinned by digest in `tools/Dockerfile`. It contains mismatched generations of some flow tools. The derived image pins:

- pyslang 10.0.0 (the earlier 9.1.0 and added GHDL Python dependencies are no longer configured);
- LibreLane 3.0.0, invoked as `/usr/local/bin/librelane`;
- Magic 8.3.684, commit `4f53bb3091d1e4a9b2009a58f157a8a4331d4c84`;
- the base image's newer OpenROAD/OpenSTA executables, not the older `openroad-librelane` wrapper environment.

The base image's LibreLane 2.4.10 understands SKY130, but not the supplied IHP PDK's renamed PDN/cell-list variables. Its older Magic also lacks the `units` command required by LibreLane 3. These are reproduced compatibility findings, not inferred version requirements.

Docker profiles resolve a tag to a local immutable image ID before compilation. Every tool invocation records arguments, selected environment, working directory, exit code, duration, and logs. Snapshot inputs and netlist/SDF contents are fingerprinted and checked on reopening.

## Performance evidence

Workstation: AMD Ryzen 5 5600H (6 cores/12 threads), approximately 16 GiB RAM, Linux 6.8 / Ubuntu 22.04. Measurements occurred alongside other development work and are not controlled release benchmarks.

A 1,074,028,999-byte VCD (one 32-bit bus, approximately 24 million timestamps) parsed successfully in the debug CLI: **33.03 seconds**, maximum resident set **1,544,364 KiB**. See `.hdlview/benchmarks/vcd-result.json` for the local raw report. The parser operates in a killable subprocess in the desktop/service; cancelling this trace during indexing returned `cancelled` in 50.7 ms. VCD parsing is not assumed to be demand-loaded.

The same trace converted to a 113 MiB FST opened in **1.77 seconds**, with **408,464 KiB** peak resident memory in the debug CLI (metadata/time-table load; visible signal query cost is separate).

The synthetic 100,000-cell graph test limits the returned view to 2,000 cells. Selection does not request layout, and cursor queries are capped at 200 visible schematic signals. A real Chromium worker laid out a synthetic 1,000-node/999-edge graph in **1.75 seconds**. The initial default layout took 12.30 seconds; views above 400 nodes now use lighter layered placement and crossing heuristics. Cached 200-signal queries over parser-worker IPC measured **3.45 ms median**, **3.84 ms p95** over 50 queries. These are worker measurements, not full Tauri-to-screen latency. [Raw performance results](performance-results.json).

## Remaining limitations and release gates

- Source views show unsupported generate constructs as opaque/unavailable. Source dependencies are not electrical gate connectivity.
- RTL DUT overrides are generated as `defparam` assignments in an isolated harness. Gate simulation uses the already-specialized netlist; hierarchy probes and explicit parameter overrides inside a shared testbench may require user adjustments after synthesis.
- Waveform binding supports exact declared paths/ranges and explicit same-range manual mappings. General compiler-renamed aliases and arbitrary slice remapping are not yet inferred. Missing signals remain unavailable.
- Bus rows can expand to 256 individual bits. The schematic retains bus connectivity and pin identities; schematic buses can expand into individual routes, with a 20,000-pin-bit limit per view. The schematic catalog intentionally covers a verified subset; unsupported interfaces retain labeled boxes.
- Snapshot content is immutable by checked fingerprints, but artifact directories are not a relocatable archive format. Working inputs may use project-relative or registered-root references; captured inputs are local to the snapshot. Recursive imports skip directory symlinks, and VHDL inputs are rejected.
- Docker builds with image-contained PDKs use a content-addressed cache keyed by captured inputs, configuration, immutable image, tool versions, and application binary. Native installations and externally mounted PDKs conservatively rebuild. Layouts and visible waveform signals are cached; a disk-backed waveform index is not implemented.
- A native profile must include compatible model files, Python bindings, plugins, and PDKs. Native/Docker parity has been checked on small workflows, not exhaustively across all language/library features.
- Macro physical flows, broader PDK corners/models, packed/unpacked SV aggregates, malformed SDF variants, and full package interaction on multiple Linux distributions still require a larger release corpus.
- The synthetic layout and cached value-query targets pass, but complete Tauri-to-screen selection/cursor latency and representative customer traces remain release benchmarks. A large synthetic trace is not a substitute for representative customer traces.

The complete accepted plan's final release criteria therefore remain broader than this preview's measured qualification. Subsequent work should use the explicit milestone gates in `HDLView_IMPLEMENTATION_PLAN.md` rather than treating a successful counter demonstration as full release acceptance.

## Project Settings qualification

The browser suite includes a no-JSON project setup workflow: settings sections, simulation addition/duplication/rename/deletion, invalid DUT paths, source-import draft preservation, external model/include/SDC/SDF pickers, duplicate defines, Apply/Cancel and local preference cancellation, narrow-window footers, real counter simulation, stale-settings run blocking, and save/close/reopen with the original waveform. Run it with the documented native profile and `tools/profiles/docker.json`. Rust tests separately verify readiness versus errors, read-only reference resolution, backend SDF/physical validation, and rejecting a changed project before starting a captured simulation. Existing cross-probing, file-management and editor workflows remain release regressions.

The completed settings change passes **63 Rust tests** (53 core and 10 identity), workspace formatting and Clippy with `-D warnings`, and **32 frontend tests**, TypeScript, ESLint, formatting and production build. All **12 browser workflows pass with each provider**, native and Docker. The new workflow configures and runs the counter testbench entirely through the form, then verifies that applied simulation changes require rebuilding while retaining the original waveform. Existing small-fixture lint checks measured 1,949 ms native and 1,948 ms Docker, including debounce; these are not general project-size benchmarks.

The rebuilt Debian package passed an isolated Xvfb smoke test using actual GTK directory, SDC and project-JSON pickers. It created an empty SKY130 project, changed to IHP, configured the design top, Icarus testbench top/DUT path and clock, selected an external SDC, and exercised Apply, Escape cancellation, Save Project, Close Project and reopening. Applied settings left JSON unchanged until Save Project; reopened controls retained the saved schema-3 settings and references. The startup log was empty with the documented software-rendering compatibility environment. Evidence is `.hdlview/project-settings-desktop-results.json` and `/tmp/hdlview-settings-desktop-smoke/` screenshots/logs. This qualifies these interactions on the current host, not every Linux desktop. No full physical flow was rerun solely for the form redesign.
