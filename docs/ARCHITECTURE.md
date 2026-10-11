# Architecture and agent handoff

`crates/hdlview-core` contains all compilation, simulation, physical-flow, graph, waveform, artifact, and job logic. It has no Tauri dependency. `crates/hdlview-cli` and `src-tauri` invoke the same `Service` and domain operations. React owns viewport/selection state, not HDL compilation or file parsing.

## Boundaries

| Module                             | Responsibility                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `model.rs`                         | Versioned project/profile/snapshot/run/graph contracts                                               |
| `project.rs`                       | Validation, input capture, fingerprints, atomic publication                                          |
| `workspace.rs`                     | Original file references, transactional import previews, scans/filelists, revision-checked documents |
| `runner.rs`                        | Native/Docker execution, image resolution, manifests, cancellation                                   |
| `pipeline.rs`                      | Frontends, representations, LibreLane, exact-netlist import, cache                                   |
| `graph.rs`                         | Module/occurrence identity, connectivity, bounded views                                              |
| `library.rs`                       | Library cell functions decoded from Liberty gate networks                                            |
| `simulation.rs`                    | Icarus/Verilator harnesses, models, SDF diagnostics                                                  |
| `waveform.rs`                      | Wellen storage and conservative declaration/range binding                                            |
| `waveprocess.rs`                   | Killable parser subprocess and bounded waveform queries                                              |
| `service.rs`                       | Application jobs, draft/project state, frontend requests                                             |
| `editor_lint.rs`                   | Working-source context validation, temporary overlays, engine results, normalized UTF-16 ranges      |
| `tools/editor_lint.py`             | Pinned pyslang diagnostic extraction, original macro/include locations and related notes             |
| `ui/editor-lint.ts`                | Debounce, latest-request coordination, contexts and project-local lint preferences                   |
| `tools/library_interfaces.py`      | Slang-derived blackbox interfaces from simulation models                                             |
| `tools/collect_physical.py`        | Strict JSON conversion of non-finite physical metrics                                                |
| `tools/gate_simulation_context.py` | Built parameter values of the design top and package-only design sources, for gate simulations       |
| `ui/components/Schematic.tsx`      | SVG renderer and view-scoped layout cache                                                            |
| `ui/layout.worker.ts`              | Cancellable ELK layout                                                                               |
| `ui/components/Waveform.tsx`       | Canvas rendering, row virtualization, bus expansion                                                  |
| `ui/components/Workspace.tsx`      | Shared sidebar, full-width panel and constrained presentation sizing                                 |
| `ui/project-workspace.tsx`         | Project wizard/imports, editor tabs, file operations, save and transition prompts                    |
| `ui/components/SourceEditor.tsx`   | Minimal CodeMirror extensions and per-tab editing history                                            |
| `ui/projects.ts`                   | Typed core service requests and native picker boundary                                               |

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

Build/import/simulation actions return job records. Poll `job`, cancel with `cancel`, and inspect retained `logs`. `wave_info`, `bindings`, `wave_window`, and `wave_values` query an open run; each waveform has its own lock, so a slow query delays only other queries of that waveform. Snapshots are shared, not copied, between requests. Timestamps cross the frontend boundary as decimal strings. The waveform subprocess is the same executable invoked with a private worker flag; it exits before desktop initialization and never requires a display.

Project schema 3 is separate from artifact schema 2. Rooted references resolve against registered directories, cannot escape them, and are normalized into `inputs/__roots/ROOT/…` during capture. The snapshot retains original-source mappings but compilers see only captured local paths. Only these schema versions are read; empty projects validate independently from build readiness.

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

Views above 400 nodes use ELK layered layout with its documented [longest-path layering](https://eclipse.dev/elk/reference/options/org-eclipse-elk-layered-layering-strategy.html) and minimal crossing thoroughness to bound interactive work; smaller views use network-simplex layering. Both use [Brandes–Köpf node placement](https://eclipse.dev/elk/reference/options/org-eclipse-elk-layered-nodePlacement-strategy.html). One layout worker stays loaded between views; a superseded or cancelled layout terminates it and the next view starts a new one. Selection never causes layout.

Project schema 3 records technology, shared simulation membership/headers, and design/simulation import records. `decode_project` reads only that schema: it registers configuration testbenches as simulation sources and merges duplicate import records, and unknown fields are errors. Resolved aliases are deduplicated on working-project load/update/save. A captured project is validated separately (`validate_captured`), because only it may name the reserved `__roots` input namespace. The selected snapshot chooses captured RTL or the exact generated netlist for an ordinary simulation configuration; SDF requires a gate snapshot and Icarus. Models are compiled only for gates. Snapshot/run identity and representation checks remain mandatory.

Creation drafts have an independent service key and actual target configuration path. Existing preview/application operations work on either key, but draft imports do not replace the active project. Final creation validates and atomically publishes the completed configuration; a new-file hard link prevents clobbering a configuration created concurrently. Closing releases the single visible parser/session and leaves artifacts on disk.

`lifecycle.rs` stores versioned machine-local checkpoints under the service cache's `project-state/`, keyed by the canonical configuration path. Each checkpoint references a snapshot and optional run; snapshots retain fingerprinted project provenance. Opening validates provenance/artifacts/binding and compares original input hashes/current configuration before returning a schematic, optional waveform path, stale flag, and warnings. Heavy waveform reopening uses the existing cancellable job. React resets presentation defaults and guards stale responses across project activation.

## Schematic presentation

An elaborated build runs a second Yosys step, `view`, on the published `elaborated.il`
and imports its `elaborated-view.json`. That step keeps every declared wire, folds
enables and resets into registers, drops undefined multiplexer inputs and dead compiler
cells, and narrows arithmetic to the bits in use. `elaborated.il` and `normalized.v`
are not rewritten, so synthesis and LibreLane inputs are unchanged. Its log is retained
but is not scanned for diagnostics, because it quotes user signal names.

`schematic.rs` classifies compiler/library cells, controls physical-cell visibility,
and recognizes bounded elaborated groups, which open as focused detail views.
A register or latch is titled with the declared net or slice that names every Q bit.
`graph.rs` retains raw parameters and ordered connectivity. Declared RTL aliases precede
hidden compiler names; gate pins retain their independent endpoint as the first identity.
Absent metadata never becomes a guessed reset.

`graph.rs` forms one net per driver set and gives every input pin its `feeds`: runs of
nets with the slice they take, constant literals and undriven runs. It emits no constant
or unconnected nodes and ends each cut bus of a bounded view in one connector.
`schematic.rs` marks asynchronous controls and orders compiler-cell pins (data, clock,
enable, resets; memory write side before read side); instances keep declaration order.
`graph.rs` splits a `$pmux` into one data and select pin per case and a memory into one
pin per port. `schematic.rs` folds a `$pmux` with its exclusive constant comparisons of
one signal into a case multiplexer group, gives instance pins a clock or reset role when
every pin they reach in the child has it, and marks disabled memory controls unused.

A mapped or post-layout build runs one more Yosys step, `library-functions`, which reads
the mapped Liberty file as logic. `library.rs` evaluates each cell's gate network into a
truth table of at most six inputs and names it: a gate with bubbles, a multiplexer, an
AND-OR or OR-AND compound with its pin groups, or a register or latch whose control
pins are traced to the storage element. A library cell with supply pins only is
physical by its interface. The function is stored on the library `Module` and is the
only source of gate symbols and pin roles: a cell is never classified from its name,
and a library that cannot be read fails the build.

`schematic-symbols.ts` supplies original SVG paths, estimated text bounds and fixed pin
anchors to both `SchematicSymbol.tsx` and `schematic-layout.ts`. A pin's anchor is the
outer end of its lead; the lead may carry a slice note, a constant or a bus-width mark,
and its `reach` becomes the size of the ELK port so neighbours stay clear of it. The
layout converter adds only layout helpers: proven control nets become connectors, a pin
with several feeds gets a join, and multi-driver or bidirectional nets get a junction
that each pin meets once. Every route maps back to its original net. Power pins remain
available in inspection outside logical routing. It never changes snapshot connectivity
or delayed endpoint bindings. Each boundary port is one ELK node constrained to a
separate first or last layer and aligned per side; component packing is disabled.
Children are listed in dataflow order with sequential outputs cut inside their strongly
connected component, and ELK breaks cycles by that model order, so registers follow
their input logic. New Yosys exports use a local ordered-port decoder without changing
generic JSON fingerprints; expanded display bits reverse storage partitions into
declared range order.

The worker normalizes electrical routes by exact original net, unions shared orthogonal
trunks, draws each stretch at the widest route covering it, and derives round junctions
from connected branches. ELK junction hints are validated against these routes.
Terminals, bends and unrelated crossings have no connection dot.
Renderer and ELK share anchors on all four sides. No edge reserves label space; a net
name is added after routing where its driver's first run has room. The presentation selection distinguishes pins from wires;
a pin retains its endpoint identity while a wire selects its entire visible exact slice.

`Schematic.tsx` caches layouts and parent cameras by graph metadata/options and geometry
version. The camera is not React state: pan and zoom write the world transform and the
grid pattern directly, and only a change of zoom level (a power of two) re-renders. Display themes, grid, inspection and selection are presentation state; only
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
The desktop SVG command selects a destination through the official dialog plugin off the
main thread; the independent core publishes the completed file atomically. Browser export
uses a download without filesystem IPC.
`SymbolGallery.tsx` uses the same production geometry for reviewed visual regression.

## Physical layout rendering

`Physical.tsx` owns the active snapshot's physical data and prepared mask scene. It loads on
first opening, remains mounted while hidden, and unmounts when the snapshot changes. Pending
requests cannot publish after cleanup, and the preparation worker is terminated on replacement.
The Rust service caches one immutable parsed physical-layout JSON artifact, shared by metadata
and layer requests; snapshot activation and project closure invalidate it. These are internal
caches: `MaskData`, `layout_masks`, and `layout_shapes` retain their existing wire formats.

`masks.worker.ts` runs `mask-scene.ts` once per scene: triangulate in database units, build
indexed meshes and placement bounds, and partition whole top-level polygons into spatial
batches. Static BVHs index the placements and routing batches. Transferred typed arrays stay
with the pane so a lost WebGL context can be rebuilt without repeating preparation.

`gl-layout.ts` owns GPU resources. Geometry and camera-relative placements use high/low float
pairs; the CPU subtracts the camera in double precision before uploading translations. All
eight orientations use the same projection. Cached VAOs/uniforms, reusable instance buffers,
and visibility-filtered index buffers avoid rebuilding meshes during navigation. Fill and
outline passes reuse each frame's placement upload. Culling includes an outline margin and
never clips polygons or substitutes cell boxes at small scales. PDK colors, patterns and depth
ordering are retained; bitmap patterns sample device pixels independently of world geometry.

`solid.rs` builds the 3D view on request from the GDS, the layer file and the PDK's 2.5D script
(`layer_stack.rs`): each material's parts are evaluated per placed cell and for the top cell
(booleans through `i_overlay`, within one cell only), optionally limited to a region that clips
the top cell's shapes and keeps placed cells whole. `solid.worker.ts` runs `solid-scene.ts` once per view: every shape becomes caps and
walls with int8 normals and outward winding (each slab's top caps first in its index range),
cells stay local, top batches are relative to their own origin, and
the same BVHs index placements and batches. `gl-solid.ts` owns the orbit camera (pivot,
azimuth, elevation, distance, z scale), the matrices in anchor-relative database units, the
footprint of the view's pyramid between the stack's planes used for culling, and instanced
draws per cell mesh and one draw per batch with back faces culled, with
index buffers filtered by material visibility and a white override for highlights. Placements
are grouped per cell into near and far, plain and mirrored (a mirrored placement reverses the
winding); a far placement, whose walls would cover under two pixels, draws only the top caps
at the start of the index buffer. The groups are rebuilt when the footprint changes or the
viewer has moved by 3 % of the camera distance. `Physical.tsx` halves the 3D pixel ratio
while frames arrive late and redraws at full resolution when the view rests.

One animation-frame callback in `Physical.tsx` takes the camera ref, viewport and display scale
and draws both WebGL masks and 2D overlays, or the 3D canvas when that tab is active. Both canvases use the same rounded backing size;
picking uses the last presented camera. Display-scale changes schedule a redraw. Context loss
pauses drawing with a visible status; restoration recreates GPU resources from the CPU scene.
Unmounting cancels scheduled frames and releases worker and GPU resources.

## Extension rules

1. Extend schema contracts and validators together. Do not add shell-interpolated commands.
2. Preserve unsupported/ambiguous data as explicit diagnostics; never invent signal connectivity or values.
3. Keep generated model interfaces separate from simulation models. Blackbox interfaces are for graph import only.
4. A physical run can publish complete artifacts and still fail DRC/LVS/timing checks. Preserve `PhysicalRun.status` and metrics independently from simulation status. The layout and check views are read from the flow's own database and report files by `tools/layout_dump.py` (names and connectivity, from OpenROAD) and `tools/collect_checks.py`, and the mask and 3D views from the final GDS, the PDK's KLayout layer file and its 2.5D script by the core's own readers (`gds.rs`, `layer_properties.rs`, `layer_stack.rs`, `masks.rs`, `solid.rs`) when the view is requested; a check without a result is "not run", never clean, and a build whose views cannot be produced is still complete, with a warning.
5. Compiler/simulator failures retain logs and never switch backends automatically.
6. Test instance/bit identity and connectivity, not exact compiler-generated names or layout coordinates.
7. Keep optional upstream reference checkouts separate from application code; add fixtures under `examples/` or tests.
8. Read `docs/QUALIFICATION.md` and its remaining gates before declaring a release complete.
