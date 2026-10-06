# Architecture and agent handoff

`crates/hdlview-core` contains all compilation, simulation, physical-flow, graph, waveform, artifact, and job logic. It has no Tauri dependency. `crates/hdlview-cli` and `src-tauri` invoke the same `Service` and domain operations. React owns viewport/selection state, not HDL compilation or file parsing.

## Boundaries

| Module                        | Responsibility                                                     |
| ----------------------------- | ------------------------------------------------------------------ |
| `model.rs`                    | Versioned project/profile/snapshot/run/graph contracts             |
| `project.rs`                  | Validation, input capture, fingerprints, atomic publication        |
| `runner.rs`                   | Native/Docker execution, image resolution, manifests, cancellation |
| `pipeline.rs`                 | Frontends, representations, LibreLane, exact-netlist import, cache |
| `graph.rs`                    | Module/occurrence identity, connectivity, bounded views            |
| `simulation.rs`               | GHDL/Icarus/Verilator harnesses, models, SDF diagnostics           |
| `waveform.rs`                 | Wellen storage and conservative declaration/range binding          |
| `waveprocess.rs`              | Killable parser subprocess and bounded waveform queries            |
| `service.rs`                  | Application jobs, session persistence, frontend requests           |
| `tools/source_graph.py`       | Isolated Slang and GHDL DOM source helpers                         |
| `tools/library_interfaces.py` | Slang-derived blackbox interfaces from simulation models           |
| `tools/collect_physical.py`   | Strict JSON conversion of non-finite physical metrics              |
| `ui/components/Schematic.tsx` | SVG renderer and view-scoped layout cache                          |
| `ui/layout.worker.ts`         | Port-aware ELK graph conversion/layout                             |
| `ui/components/Waveform.tsx`  | Canvas rendering, row virtualization, bus expansion                |

## Identity and invariants

`identity(snapshot, path_segments, kind)` uses JSON-encoded path segments. Dots inside escaped identifiers cannot collide with hierarchy separators. Yosys wire numbers stay local to their module. Module definitions and instance occurrences remain separate.

A `SimulationRun` contains the snapshot ID, representation, actual trace hash, DUT scope, simulator, and diagnostics. Both IDs and stage must match when opening/binding a run. Native source edits cannot change captured inputs. Reopening checks the captured source/netlist/SDF hashes.

Bindings use explicit testbench/DUT root mapping and exact declaration/range matching, or a saved manual mapping. There is no fuzzy/basename fallback. Connected gate-cell pins have separate identities, allowing interconnect-delayed waveform values to differ. Compiler-only signals stay unavailable.

The local JSON-lines CLI request has shape `{"action":"view","args":{"snapshot_id":"...","scope":["counter"]}}`; responses are `{"ok":true,"result":...}` or `{"ok":false,"error":"..."}`. The desktop's thin IPC adapter uses the same request service. It does not listen on a network socket.

Build/import/simulation actions return job records. Poll `job`, cancel with `cancel`, and inspect retained `logs`. `wave_info`, `bindings`, `wave_window`, and `wave_values` query an open run. Timestamps cross the frontend boundary as decimal strings. The waveform subprocess is the same executable invoked with a private worker flag; it exits before desktop initialization and never requires a display.

Large views use ELK layered layout with its documented [longest-path layering](https://eclipse.dev/elk/reference/options/org-eclipse-elk-layered-layering-strategy.html) and [simple node placement](https://eclipse.dev/elk/reference/options/org-eclipse-elk-layered-nodePlacement-strategy.html) to bound interactive work. Small views retain the default fuller heuristics. Layout workers are cancellable; selection never causes layout.

## Extension rules

1. Extend schema contracts and validators together. Do not add shell-interpolated commands.
2. Preserve unsupported/ambiguous data as explicit diagnostics; never invent signal connectivity or values.
3. Keep generated model interfaces separate from simulation models. Blackbox interfaces are for graph import only.
4. A physical run can publish complete artifacts and still fail DRC/LVS/timing checks. Preserve `PhysicalRun.status` and metrics independently from simulation status.
5. Compiler/simulator failures retain logs and never switch backends automatically.
6. Test instance/bit identity and connectivity, not exact compiler-generated names or layout coordinates.
7. Keep optional upstream reference checkouts separate from application code; add fixtures under `examples/` or tests.
8. Read `docs/QUALIFICATION.md` and its remaining gates before declaring a release complete.
