# Simulation and annotation

Inspect [simulation.rs](../../../../crates/hdlview-core/src/simulation.rs), the selected
project simulation configuration, generated run harness, and `manifest.json`.
The snapshot's captured profile and inputs determine the actual simulation.

- Keep synthesis sources and testbench sources separate. Check testbench top,
  DUT scope, runtime arguments, stop time, dump instrumentation, and expected trace.
  Generate instrumentation in the run directory; do not edit user HDL to obtain a dump.
- VHDL RTL uses GHDL. Verilog/SystemVerilog RTL uses the explicitly selected Icarus
  or Verilator. Gate netlists use Verilog-compatible testbenches; a VHDL-origin
  design needs a separate gate testbench. Named port connections avoid declaration
  reordering by physical tools.
- For gate models, check actual functional Verilog models, primitives, include
  directories, conditional defines, and power-pin conventions. Liberty and the
  generated graph blackboxes are insufficient for simulation.
- For Icarus runtime failures, inspect `vvp` library paths as well as the compiler
  executable. For Verilator build failures, check the generated C++ build and
  writable cache/output directories before changing HDL semantics.
- SDF runs require Icarus and a gate snapshot. Inspect the actual `-gspecify` and
  `-ginterconnect` options, annotation DUT instance, exact netlist/SDF pair, models,
  timescale, selected corner, and `min`/`typ`/`max` selection. These last two choices
  are independent; snapshot SDF uses `max` by default for sparse OpenSTA triples.
  A missing selected delay is an error, not an assumed zero.
- Inspect annotation warnings even when the simulator exits successfully.
  Icarus's unsupported `TIMINGCHECK` sections and the qualified IHP `COND` limitation
  must stay visible. Test delay behavior separately from timing-check coverage.

Compare assertions and expected transitions with the affected real simulator/model
set. For SDF changes, compare zero-delay and annotated transitions and exercise the
relevant wrong-instance or missing-delay failure. If simulation succeeds but a signal
does not bind, inspect the dumped declarations using CLI `wave` and then follow
[the cross-probing workflow](../../hdlview-cross-probing/SKILL.md).
