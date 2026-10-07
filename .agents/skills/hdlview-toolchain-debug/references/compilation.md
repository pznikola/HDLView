# Compilation and graph export

Inspect [pipeline.rs](../../../../crates/hdlview-core/src/pipeline.rs) for generated
frontend scripts and export/import steps; [source_graph.py](../../../../tools/source_graph.py)
owns source behavior extraction. Use `source`, `elaborated`, `generic`, `mapped`,
or `post_layout` exactly as accepted by the CLI.

- For source RTL, reproduce through the isolated Python helper using the captured
  project and helper inputs. Check `pyslang` compatibility for Verilog/SystemVerilog
  only. Unsupported constructs
  remain diagnostic/opaque; do not recover source behavior from a synthesized graph.
- For elaboration, inspect source ordering, standards, includes,
  defines, parameters, top selection, and plugin loading. The export
  lowers processes with `proc` and collects memories before JSON output. Preserve
  hierarchy and word-level operations; do not add synthesis optimization to fix
  an elaborated-view mismatch.
- For generic synthesis, inspect the exported netlist and its graph re-import.
  For mapped synthesis, inspect the LibreLane synthesis stage and actual library
  selection. A separate hand-written `abc -liberty` path cannot stand in for the
  production PDK flow.
- For gate graphs, import the exact exported simulation netlist without resynthesis.
  [library_interfaces.py](../../../../tools/library_interfaces.py) extracts graph
  interfaces from models; these blackbox interfaces are not simulation models.
  Keep unknown cells explicit rather than inventing connectivity.

Use `tests/fixtures/counter` for repeated SV instances and `tests/fixtures/verilog` for Verilog
range-direction behavior. Add only the failing language construct to a focused fixture. Check
connectivity, occurrence identity, width, and source references rather than compiler
temporary names. A source-helper edit must be exercised with its matching compiler;
Python syntax checks alone do not validate that interface.
