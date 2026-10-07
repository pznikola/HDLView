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
| `editor_lint.rs`                 | Working-source context validation, temporary overlays, engine results, normalized UTF-16 ranges      |
| `tools/editor_lint.py`           | Pinned pyslang diagnostic extraction, original macro/include locations and related notes             |
| `ui/editor-lint.ts`              | Debounce, latest-request coordination, contexts and project-local lint preferences                   |
| `tools/source_graph.py`          | Isolated Slang source helper                                                                         |
| `tools/library_interfaces.py`    | Slang-derived blackbox interfaces from simulation models                                             |
| `tools/collect_physical.py`      | Strict JSON conversion of non-finite physical metrics                                                |
| `ui/components/Schematic.tsx`    | SVG renderer and view-scoped layout cache                                                            |
| `ui/layout.worker.ts`            | Cancellable ELK layout                                                                               |
| `ui/components/Waveform.tsx`     | Canvas rendering, row virtualization, bus expansion                                                  |
| `ui/components/Workspace.tsx`    | Shared sidebar, full-width panel and constrained presentation sizing                                 |
| `ui/project-workspace.tsx`       | Project wizard/imports, editor tabs, file operations, save and transition prompts                    |
| `ui/components/SourceEditor.tsx` | Minimal CodeMirror extensions and per-tab editing history                                            |
| `ui/projects.ts`                 | Typed core service requests and native picker boundary                                               |

`settings.rs` owns shared field validation, readiness warnings and non-publishing picker-reference resolution. `validate_project_settings` optionally compares a candidate with a snapshot's original project fingerprint. `resolve_settings_inputs` returns a normalized settings draft and references without writing or publishing them. The existing project update/save operations enforce shared validation; project-bound simulation rejects settings that differ from its captured snapshot before launching tools.

`ProjectSettings.tsx` owns the categorized settings dialog and its draft. `ui/project-settings.ts` converts editable maps, duration units and optional override JSON into the existing project schema, and rebases explicitly imported membership without losing unapplied edits. Apply updates the working configuration; saving remains explicit. Local editor preferences are applied separately and excluded from project/artifact fingerprints. Settings dialogs trap focus and make the workspace inert; reviewed source-import overlays temporarily cover the settings dialog without unmounting its draft.

`file_management.rs` owns exclusive empty-file/folder creation, registered-entry metadata, reviewed rename/removal/Trash, reference rewriting, and original-path inspection. `ui/source-explorer.ts` constructs the registered tree; `SourceExplorer.tsx` owns tree selection/expansion and keyboard/context interaction. `FileManagementDialog.tsx` presents creation and reviewed changes. Editor tab identity remains stable through rename; its document reference changes without recreating CodeMirror history.

`create_file_entry` returns a working configuration plus its created reference. `preview_file_change`/`apply_file_change` use cancellable `files` jobs and project/disk revision checks; application returns reference changes for tabs. Completed file jobs and preview tokens are bounded. A dedicated mutation lock serializes filesystem/configuration changes and job starts without holding the service state lock during I/O; other mutations cannot run while a file job is active. Cancellation is checked during inspection and before disk commit. A committed operation publishes its real state even if cancellation arrives afterward.

Optional `ImportRecord.exclusions` retains removed file/directory membership through rescans. Empty directories reuse folder import records. Configuration remains schema 3, and empty metadata is omitted to preserve older artifact serialization. Disk operations take effect immediately; saving membership remains explicit. Removal closes affected working tabs after the dirty-state guard and leaves captured tabs/session artifacts intact. Linux Trash invokes system GIO with argument arrays on the host, independently of the toolchain provider, without a permanent-delete fallback.

## Identity and invariants

`identity(snapshot, path_segments, kind)` uses JSON-encoded path segments. Dots inside escaped identifiers cannot collide with hierarchy separators. Yosys wire numbers stay local to their module. Module definitions and instance occurrences remain separate.

A `SimulationRun` contains the snapshot ID, representation, actual trace hash, DUT scope, simulator, and diagnostics. Both IDs and stage must match when opening/binding a run. Native source edits cannot change captured inputs. Reopening checks the captured source/netlist/SDF hashes.

Simulation trace collection inspects only the newly created run directory. A valid
expected trace takes precedence; when absent, Wellen header inspection requires one
VCD/FST with the exact DUT scope and dumped variables. Symlinks are excluded, resolved
paths must stay inside that run, and ambiguous/malformed/wrong-scope results fail
explicitly. The selected trace and content hash are included in both run and manifest.

Bindings use explicit testbench/DUT root mapping and exact declaration/range matching, or a saved manual mapping. There is no fuzzy/basename fallback. Connected gate-cell pins have separate identities, allowing interconnect-delayed waveform values to differ. Compiler-only signals stay unavailable.

The local JSON-lines CLI request has shape `{"action":"view","args":{"snapshot_id":"...","scope":["counter"]}}`; responses are `{"ok":true,"result":...}` or `{"ok":false,"error":"..."}`. The desktop's thin IPC adapter uses the same request service. It does not listen on a network socket.

Build/import/simulation actions return job records. Poll `job`, cancel with `cancel`, and inspect retained `logs`. `wave_info`, `bindings`, `wave_window`, and `wave_values` query an open run. Timestamps cross the frontend boundary as decimal strings. The waveform subprocess is the same executable invoked with a private worker flag; it exits before desktop initialization and never requires a display.

Project schema 3 is separate from artifact schema 1. Rooted references resolve against registered directories, cannot escape them, and are normalized into `inputs/__roots/ROOT/…` during capture. The snapshot retains original-source mappings but compilers see only captured local paths. Version-1/2 Verilog/SystemVerilog projects migrate only on explicit save; empty projects validate independently from build readiness.

`preview_import` returns a cancellable job and a review token. `apply_import` checks the project's configuration fingerprint before applying selected roles to its working configuration; saving is explicit. Expanded lists remain stable until explicit reimport. `read_document` and `save_document` accept registered references and HDL headers beneath configured includes or compilation-unit directories, still enforcing source-root boundaries. Saves compare content revisions and preserve BOM/newlines. The desktop grants dialog-open and window-destroy permissions without frontend filesystem access; window destruction follows the dirty-state prompt. Snapshot source navigation reads captured text; working-file navigation resolves the saved original mapping separately.

`lint` accepts `EditorLintRequest` against an open working project, never an immutable
snapshot. Rust validates membership, selects ordered design/testbench units,
overlays open normalized buffers in separate root namespaces, and runs pinned
pyslang and Verible through the existing runner. Simulator-specific defines and
DUT parameter specialization are preserved; unsupported dialect differences are
explicit. Original byte ranges become UTF-16 ranges against the exact normalized
text checked. `EditorLintResult` records generations, input hashes, engine status,
related locations, and truncation independently from compiler/run diagnostics.

The React coordinator debounces 750 ms, cancels superseded work, retains one latest
pending request, and installs results only for its current project/profile/context/
buffers signature and generation. Edits invalidate displayed results immediately.
The configured profile remains independent of restored snapshots: lint and new
builds use current tool settings, while snapshot simulation uses its recorded
profile for reproducibility.
Other jobs cancel/pause lint; background lint never guards File transitions. Each
engine times out after at most 10 seconds. Only one completed lint job and its latest
logs remain; temporary inputs are removed on success, failure, or cancellation.
CodeMirror diagnostic effects preserve document history/selection; Problems is an
explicit bottom-panel tab. Project-local lint toggles stay in presentation preferences
outside project schema and compilation fingerprints.

Large views use ELK layered layout with its documented [longest-path layering](https://eclipse.dev/elk/reference/options/org-eclipse-elk-layered-layering-strategy.html) and [simple node placement](https://eclipse.dev/elk/reference/options/org-eclipse-elk-layered-nodePlacement-strategy.html) to bound interactive work. Small views retain the default fuller heuristics. Layout workers are cancellable; selection never causes layout.

Project schema 3 records technology, shared simulation membership/headers, and design/simulation import records. `decode_project` is the compatibility boundary for legacy working configurations and embedded snapshot projects: it removes stage restrictions, merges former simulation groups, preserves testbench order, and rejects unsupported VHDL/GHDL configurations. Resolved aliases are deduplicated on working-project load/update/save. Serialization writes only current contracts. Older artifact bytes and provenance hashes are not rewritten. The selected snapshot chooses captured RTL or the exact generated netlist for an ordinary simulation configuration; SDF requires a gate snapshot and Icarus. Models are compiled only for gates. Snapshot/run identity and representation checks remain mandatory.

Creation drafts have an independent service key and actual target configuration path. Existing preview/application operations work on either key, but draft imports do not replace the active project. Final creation validates and atomically publishes the completed configuration; a new-file hard link prevents clobbering a configuration created concurrently. Closing releases the single visible parser/session and leaves artifacts on disk.

`lifecycle.rs` stores versioned machine-local checkpoints under the service cache's `project-state/`, keyed by the canonical configuration path. Each checkpoint references a snapshot and optional run; snapshots retain fingerprinted project provenance. Opening validates provenance/artifacts/binding and compares original input hashes/current configuration before returning a schematic, optional waveform path, stale flag, and warnings. Heavy waveform reopening uses the existing cancellable job. The old global session is not migrated automatically. React resets presentation defaults and guards stale responses across project activation.

## Schematic presentation

`schematic.rs` classifies compiler/library cells, controls physical-cell visibility,
recognizes bounded elaborated groups and constructs captured behavioral detail views.
`graph.rs` retains raw parameters and ordered connectivity. Declared RTL aliases precede
hidden compiler names; gate pins retain their independent endpoint as the first identity.
New optional cell behavior/parameter fields leave old artifact bytes and hashes intact.
Absent metadata never becomes a guessed reset or synthesized source explanation.

`source_graph.py` captures Slang statements/expressions, spans, call targets and formal
signatures alongside process summaries. Detail edges distinguish data dependencies and
sequencing. Assignment outputs bind written declarations; operand inputs bind upstream
references, and control-flow edges never acquire waveform values. Formals/temporaries
remain unbound. Capture and focused views are bounded; unsupported AST constructs emit
opaque nodes and diagnostics.

`schematic-symbols.ts` supplies original SVG paths, measured text bounds and fixed pin
anchors to both `SchematicSymbol.tsx` and `schematic-layout.ts`. The layout converter clones
only layout helpers, folds proven control nets into connectors, localizes constants, adds
ordered bus joins/splits and multi-driver junctions, and maps every route back to original
connectivity/selection identities. Power pins remain available in inspection outside
logical routing. It never changes snapshot connectivity or delayed endpoint bindings.
Boundary ports use two fixed-order invisible ELK columns with partitions; component
packing is disabled for these views. Helpers flatten back into original objects after
layout. New Yosys exports use a local ordered-port decoder without changing generic JSON
fingerprints; expanded display bits reverse storage partitions into declared range order.

The worker normalizes simple electrical routes by exact original net/slice identity,
unions shared orthogonal trunks, and derives round junctions from connected branches.
ELK junction hints are validated against these routes. Terminals, bends, procedural
edges and unrelated crossings have no connection dot. Renderer/ELK share border anchors
including bottom controls. The presentation selection distinguishes pins from wires;
a pin retains its endpoint identity while a wire selects its entire visible exact slice.

`Schematic.tsx` caches layouts and parent cameras by graph metadata/options and geometry
version. Display themes, grid, inspection and selection are presentation state; only
semantic view changes or full-wiring changes cause new layout. Local preferences live in
`schematic-display.ts`, outside project configuration/fingerprints. SVG exports contain
styles and labels at logical coordinates, without transient hit/selection/expand overlays.
The camera transforms the world-anchored 24-unit grid; coarser powers-of-four levels
keep dots at least eight pixels apart. No grid is exported.

`Workspace.tsx` owns presentation sizing: an upper grid contains the shared
Sources/Design/Inspector sidebar and editor/schematic workspace; a full-width
bottom panel switches between Waveforms, Logs and Problems. Its resize handles
support pointer capture, keyboard adjustment and bounded dimensions. The
editor/schematic split remains within 20–80%, reserving 200/320 pixels respectively
when space permits. The sidebar
is 224–420 pixels; the bottom panel defaults to 35%, constrained to retain 260
pixels above and 140 pixels below on supported windows. Sidebar views and bottom
views stay mounted when hidden, preserving explorer expansion, editor history,
waveform range/radix/cursor and scroll positions. Hidden waveforms pause window
queries. Schematic collapse does not unmount the renderer or reset its camera.
Selecting objects never changes the selected sidebar view. Sizing and panel
selection are independent of graph identity and compilation fingerprints.
Source dependency/control routes include arrowheads; electrical wires remain undirected.
The desktop SVG command selects a destination through the official dialog plugin off the
main thread; the independent core publishes the completed file atomically. Browser export
uses a download without filesystem IPC.
`SymbolGallery.tsx` uses the same production geometry for reviewed visual regression.

## Extension rules

1. Extend schema contracts and validators together. Do not add shell-interpolated commands.
2. Preserve unsupported/ambiguous data as explicit diagnostics; never invent signal connectivity or values.
3. Keep generated model interfaces separate from simulation models. Blackbox interfaces are for graph import only.
4. A physical run can publish complete artifacts and still fail DRC/LVS/timing checks. Preserve `PhysicalRun.status` and metrics independently from simulation status.
5. Compiler/simulator failures retain logs and never switch backends automatically.
6. Test instance/bit identity and connectivity, not exact compiler-generated names or layout coordinates.
7. Keep optional upstream reference checkouts separate from application code; add fixtures under `examples/` or tests.
8. Read `docs/QUALIFICATION.md` and its remaining gates before declaring a release complete.
