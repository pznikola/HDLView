# Qualification — 6 October 2026

This file records exercised workflows separately from proposed release targets. Version 0.1.0 is an engineering preview; it is not a claim of complete HDL-language coverage or signoff-quality timing simulation.

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
- Bus rows can expand to 256 individual bits. The schematic retains bus connectivity and pin identities; schematic buses can expand into individual routes, with a 20,000-pin-bit limit per view. Richer standard-cell symbols remain extension work.
- Snapshot content is immutable by checked fingerprints, but artifact directories are not a relocatable archive format. Working inputs may use project-relative or registered-root references; captured inputs are local to the snapshot. Recursive imports skip directory symlinks, and VHDL inputs are rejected.
- Docker builds with image-contained PDKs use a content-addressed cache keyed by captured inputs, configuration, immutable image, tool versions, and application binary. Native installations and externally mounted PDKs conservatively rebuild. Layouts and visible waveform signals are cached; a disk-backed waveform index is not implemented.
- A native profile must include compatible model files, Python bindings, plugins, and PDKs. Native/Docker parity has been checked on small workflows, not exhaustively across all language/library features.
- Macro physical flows, broader PDK corners/models, packed/unpacked SV aggregates, malformed SDF variants, and full package interaction on multiple Linux distributions still require a larger release corpus.
- The synthetic layout and cached value-query targets pass, but complete Tauri-to-screen selection/cursor latency and representative customer traces remain release benchmarks. A large synthetic trace is not a substitute for representative customer traces.

The complete accepted plan's final release criteria therefore remain broader than this preview's measured qualification. Subsequent work should use the explicit milestone gates in `HDLView_IMPLEMENTATION_PLAN.md` rather than treating a successful counter demonstration as full release acceptance.
