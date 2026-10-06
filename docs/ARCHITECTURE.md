# Architecture and agent handoff

`crates/hdlview-core` contains all compilation, simulation, physical-flow, graph, waveform, artifact, and job logic. It has no Tauri dependency. `crates/hdlview-cli` and `src-tauri` invoke the same `Service` and domain operations. React owns viewport/selection state, not HDL compilation or file parsing.

## Boundaries

| Module                           | Responsibility                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `model.rs`                       | Versioned project/profile/snapshot/run/graph contracts                                               |
| `project.rs`                     | Validation, input capture, fingerprints, atomic publication                                          |
| `workspace.rs`                   | Original file references, transactional import previews, scans/filelists, revision-checked documents |
| `runner.rs`                      | Native/Docker execution, image resolution, manifests, cancellation                                   |
| `pipeline.rs`                    | Frontends, representations, LibreLane, exact-netlist import, cache                                   |
| `graph.rs`                       | Module/occurrence identity, connectivity, bounded views                                              |
| `simulation.rs`                  | Icarus/Verilator harnesses, models, SDF diagnostics                                                  |
| `waveform.rs`                    | Wellen storage and conservative declaration/range binding                                            |
| `waveprocess.rs`                 | Killable parser subprocess and bounded waveform queries                                              |
| `service.rs`                     | Application jobs, draft/project state, frontend requests                                             |
| `tools/source_graph.py`          | Isolated Slang source helper                                                                         |
| `tools/library_interfaces.py`    | Slang-derived blackbox interfaces from simulation models                                             |
| `tools/collect_physical.py`      | Strict JSON conversion of non-finite physical metrics                                                |
| `ui/components/Schematic.tsx`    | SVG renderer and view-scoped layout cache                                                            |
| `ui/layout.worker.ts`            | Port-aware ELK graph conversion/layout                                                               |
| `ui/components/Waveform.tsx`     | Canvas rendering, row virtualization, bus expansion                                                  |
| `ui/project-workspace.tsx`       | Project wizard/settings/explorer, editor tabs, save and transition prompts                           |
| `ui/components/SourceEditor.tsx` | Minimal CodeMirror extensions and per-tab editing history                                            |
| `ui/projects.ts`                 | Typed core service requests and native picker boundary                                               |

## Identity and invariants

`identity(snapshot, path_segments, kind)` uses JSON-encoded path segments. Dots inside escaped identifiers cannot collide with hierarchy separators. Yosys wire numbers stay local to their module. Module definitions and instance occurrences remain separate.

A `SimulationRun` contains the snapshot ID, representation, actual trace hash, DUT scope, simulator, and diagnostics. Both IDs and stage must match when opening/binding a run. Native source edits cannot change captured inputs. Reopening checks the captured source/netlist/SDF hashes.

Bindings use explicit testbench/DUT root mapping and exact declaration/range matching, or a saved manual mapping. There is no fuzzy/basename fallback. Connected gate-cell pins have separate identities, allowing interconnect-delayed waveform values to differ. Compiler-only signals stay unavailable.

The local JSON-lines CLI request has shape `{"action":"view","args":{"snapshot_id":"...","scope":["counter"]}}`; responses are `{"ok":true,"result":...}` or `{"ok":false,"error":"..."}`. The desktop's thin IPC adapter uses the same request service. It does not listen on a network socket.

Build/import/simulation actions return job records. Poll `job`, cancel with `cancel`, and inspect retained `logs`. `wave_info`, `bindings`, `wave_window`, and `wave_values` query an open run. Timestamps cross the frontend boundary as decimal strings. The waveform subprocess is the same executable invoked with a private worker flag; it exits before desktop initialization and never requires a display.

Project schema 3 is separate from artifact schema 1. Rooted references resolve against registered directories, cannot escape them, and are normalized into `inputs/__roots/ROOT/…` during capture. The snapshot retains original-source mappings but compilers see only captured local paths. Version-1/2 Verilog/SystemVerilog projects migrate only on explicit save; empty projects validate independently from build readiness.

`preview_import` returns a cancellable job and a review token. `apply_import` checks the project's configuration fingerprint before applying selected roles to its working configuration; saving is explicit. Expanded lists remain stable until explicit reimport. `read_document` and `save_document` accept only registered references. Saves compare content revisions and preserve BOM/newlines. The desktop grants dialog-open and window-destroy permissions without frontend filesystem access; window destruction follows the dirty-state prompt. Snapshot source navigation reads captured text; working-file navigation resolves the saved original mapping separately.

Large views use ELK layered layout with its documented [longest-path layering](https://eclipse.dev/elk/reference/options/org-eclipse-elk-layered-layering-strategy.html) and [simple node placement](https://eclipse.dev/elk/reference/options/org-eclipse-elk-layered-nodePlacement-strategy.html) to bound interactive work. Small views retain the default fuller heuristics. Layout workers are cancellable; selection never causes layout.

Project schema 3 records technology, shared simulation membership/headers, and design/simulation import records. `decode_project` is the compatibility boundary for legacy working configurations and embedded snapshot projects: it removes stage restrictions, merges former simulation groups, preserves testbench order, and rejects unsupported VHDL/GHDL configurations. Resolved aliases are deduplicated on working-project load/update/save. Serialization writes only current contracts. Older artifact bytes and provenance hashes are not rewritten. The selected snapshot chooses captured RTL or the exact generated netlist for an ordinary simulation configuration; SDF requires a gate snapshot and Icarus. Models are compiled only for gates. Snapshot/run identity and representation checks remain mandatory.

Creation drafts have an independent service key and actual target configuration path. Existing preview/application operations work on either key, but draft imports do not replace the active project. Final creation validates and atomically publishes the completed configuration; a new-file hard link prevents clobbering a configuration created concurrently. Closing releases the single visible parser/session and leaves artifacts on disk.

`lifecycle.rs` stores versioned machine-local checkpoints under the service cache's `project-state/`, keyed by the canonical configuration path. Each checkpoint references a snapshot and optional run; snapshots retain fingerprinted project provenance. Opening validates provenance/artifacts/binding and compares original input hashes/current configuration before returning a schematic, optional waveform path, stale flag, and warnings. Heavy waveform reopening uses the existing cancellable job. The old global session is not migrated automatically. React resets presentation defaults and guards stale responses across project activation.

## Extension rules

1. Extend schema contracts and validators together. Do not add shell-interpolated commands.
2. Preserve unsupported/ambiguous data as explicit diagnostics; never invent signal connectivity or values.
3. Keep generated model interfaces separate from simulation models. Blackbox interfaces are for graph import only.
4. A physical run can publish complete artifacts and still fail DRC/LVS/timing checks. Preserve `PhysicalRun.status` and metrics independently from simulation status.
5. Compiler/simulator failures retain logs and never switch backends automatically.
6. Test instance/bit identity and connectivity, not exact compiler-generated names or layout coordinates.
7. Keep optional upstream reference checkouts separate from application code; add fixtures under `examples/` or tests.
8. Read `docs/QUALIFICATION.md` and its remaining gates before declaring a release complete.
