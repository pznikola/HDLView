# LibreLane and physical artifacts

Inspect `run_physical` and collection in [pipeline.rs](../../../../crates/hdlview-core/src/pipeline.rs),
[collect_physical.py](../../../../tools/collect_physical.py), and the run's `librelane.json`,
original flow log, structured state, and reports.

1. Check normalized Verilog, top, clock/SDC configuration, PDK/library, and effective
   flow overrides. Compare the resolved tool/profile environment with
   [qualification findings](../../../../docs/QUALIFICATION.md#toolchain-qualification-findings).
   The qualified derived image uses `/usr/local/bin/librelane` and compatible
   OpenROAD/OpenSTA/Magic; the base image's legacy wrapper is not equivalent.
2. Find the first failing flow step and distinguish tool/configuration failure from
   a completed run with failed checks. Preserve STA, DRC, and LVS results and
   `PhysicalRun.status` independently. The documented IHP Magic DRC violations
   are existing evidence, not grounds to suppress checkers to obtain a green run.
3. Collect final artifacts from the flow's structured state. Preserve non-finite
   metric handling and checker diagnostics. Do not substitute an earlier netlist
   when final import or model-interface extraction fails.
4. If the flow produced its outputs but collection/import failed, consider CLI
   `resume-physical DIRECTORY` after fixing the cause. Inspect captured hashes and
   prerequisites first; this path cannot overwrite an existing published snapshot.
5. Verify that the post-layout graph and simulation share the exact final netlist,
   matching SDF and corner, and functional models. Include clock-tree and physical
   buffering changes. A post-route SDF must not annotate the earlier mapped graph.

Re-run only the affected stage where that provides meaningful evidence; changes to
the complete flow require a small end-to-end run for the affected PDK. Use both PDKs
when changing shared flow behavior. Read `tools/qualify.py` before invoking its
`--physical` matrix, since it launches complete flows rather than a quick unit test.
