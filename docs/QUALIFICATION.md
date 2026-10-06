# Qualification — 6 October 2026

This file records exercised workflows separately from proposed release targets. Version 0.1.0 is an engineering preview; it is not a claim of complete HDL-language coverage or signoff-quality timing simulation.

## Exercised workflows

- Rust unit/integration tests cover identity, repeated instances, aliases, range offsets/direction, stage isolation, endpoint identity, bounded 100,000-cell views, large timestamps, input copies, process errors, and argument validation.
- A real browser test builds hierarchical SystemVerilog with Slang/Yosys, simulates with Icarus, selects in both directions across repeated instances, and checks the stage-switch restriction.
- Native Icarus, Verilator, and GHDL simulations pass the counter testbenches. Wellen reads their VCD and GHW traces.
- The Docker source helpers extract SV procedural dependencies and VHDL processes, expressions, entity instances, and simple generic ranges.
- Generic synthesis and both PDK mapped synthesis/gate simulation pass. The repeatable Docker matrix has 36 successful case results, including a successful retry after fixing Verilator's writable cache directory. [Raw results](qualification-results.json) retain the initial failure.
- Both SKY130 and IHP complete all 80 LibreLane Classic stages and produce final netlists, SDFs, GDS, timing data, and reports. SKY130 completes without deferred checker errors. **IHP reports eight Magic DRC violations**, while KLayout DRC reports zero and LVS/setup/hold checks pass. These outcomes remain independently visible; IHP's physical run is marked `failed_checks`.
- Zero-delay and SDF-annotated simulations of both final netlists pass the named-port testbenches. The exact exported netlist is imported into the schematic; fillers are resolved through model-derived interfaces. Comparing the first output transition against the zero-delay run measured 1.187 ns of delay for SKY130 and 0.407 ns for IHP. [Observed SDF delays](sdf-delay-results.json).
- Icarus reports unsupported `TIMINGCHECK` sections, and IHP additionally reports unsupported conditional `COND` delays. These warnings remain in the run. Passing the testbench is **not** full timing verification or full annotation coverage.
- Desktop compilation and virtual-display startup were exercised in a Linux container. The release package targets Ubuntu 22.04-compatible glibc and requires the distribution's WebKitGTK 4.1 runtime.

## Toolchain qualification findings

The base `hpretl/iic-osic-tools:2025.12` image is pinned by digest in `tools/Dockerfile`. It contains mismatched generations of some flow tools. The derived image pins:

- pyslang 9.1.0;
- pyGHDL at GHDL commit `dc2c18aa`, pyVHDLModel 0.33.0, pyTooling 8.8.0;
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

- Source views deliberately show unsupported generate constructs and non-integral/complex VHDL types as opaque/unavailable. VHDL multi-library duplicate entity names and complex configurations need additional qualification. Source dependencies are not electrical gate connectivity.
- VHDL top-level generic overrides cannot currently be applied automatically to an arbitrary testbench DUT. Such simulations fail explicitly; use a shared specialized wrapper entity. SV RTL DUT overrides are generated as `defparam` assignments in an isolated harness.
- Waveform binding supports exact declared paths/ranges and explicit same-range manual mappings. General compiler-renamed aliases and arbitrary slice remapping are not yet inferred. Missing signals remain unavailable.
- Bus rows can expand to 256 individual bits. The schematic retains bus connectivity and pin identities; schematic buses can expand into individual routes, with a 20,000-pin-bit limit per view. Richer standard-cell symbols remain extension work.
- Snapshot content is immutable by checked fingerprints, but artifact directories are not a relocatable archive format. Inputs must currently be project-relative; directory symlinks and mixed-language projects are rejected.
- Docker builds with image-contained PDKs use a content-addressed cache keyed by captured inputs, configuration, immutable image, tool versions, and application binary. Native installations and externally mounted PDKs conservatively rebuild. Layouts and visible waveform signals are cached; a disk-backed waveform index is not implemented.
- A native profile must include compatible model files, Python bindings, plugins, and PDKs. Native/Docker parity has been checked on small workflows, not exhaustively across all language/library features.
- Macro physical flows, broader PDK corners/models, packed/unpacked SV aggregates, VHDL extended values, malformed SDF variants, and full package interaction on multiple Linux distributions still require a larger release corpus.
- The synthetic layout and cached value-query targets pass, but complete Tauri-to-screen selection/cursor latency and representative customer traces remain release benchmarks. A large synthetic trace is not a substitute for representative customer traces.

The complete accepted plan's final release criteria therefore remain broader than this preview's measured qualification. Subsequent work should use the explicit milestone gates in `HDLView_IMPLEMENTATION_PLAN.md` rather than treating a successful counter demonstration as full release acceptance.
