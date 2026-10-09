# Compilation and graph export

Inspect [pipeline.rs](../../../../crates/hdlview-core/src/pipeline.rs) for generated
frontend scripts and export/import steps. Use `elaborated`, `mapped`, or `post_layout`
exactly as accepted by the CLI.

- For elaboration, inspect source ordering, standards, includes,
  defines, parameters, top selection, and plugin loading. The export
  lowers processes with `proc` and collects memories before JSON output. Preserve
  hierarchy and word-level operations; do not add synthesis optimization to fix
  an elaborated-view mismatch.
- For mapped synthesis, inspect the LibreLane synthesis stage and actual library
  selection. A separate hand-written `abc -liberty` path cannot stand in for the
  production PDK flow.
- For gate graphs, import the exact exported simulation netlist without resynthesis.
  [library_interfaces.py](../../../../tools/library_interfaces.py) extracts graph
  interfaces from models; these blackbox interfaces are not simulation models.
  Keep unknown cells explicit rather than inventing connectivity.

Use `tests/fixtures/counter` for repeated SV instances and `tests/fixtures/verilog` for Verilog
range-direction behavior. Add only the failing language construct to a focused fixture. Check
connectivity, occurrence identity, width, and source references rather than compiler
temporary names. A Python helper edit must be exercised with its matching tools;
Python syntax checks alone do not validate that interface.
