# Architecture rules

These rules preserve HDLView's boundaries. They do not require extra layers,
folders, interfaces, or a rewrite of existing modules. The
[implementation plan](../../../../HDLView_IMPLEMENTATION_PLAN.md) defines product scope;
[architecture documentation](../../../../docs/ARCHITECTURE.md) describes the implementation.

## Work in the existing structure

| Location               | Responsibility                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `crates/hdlview-core/` | Project state, snapshots, graph identity, jobs, tool adapters, waveform access and binding. Independent of Tauri. |
| `crates/hdlview-cli/`  | Headless entry point using the same core operations.                                                              |
| `src-tauri/`           | Desktop state wiring and thin IPC adapters to the core.                                                           |
| `ui/`                  | React presentation, interaction, typed API calls, and layout workers.                                             |
| `tools/`               | Isolated compiler/flow helpers, qualification and packaging scripts.                                              |
| `examples/`, `tests/`  | Small design fixtures and acceptance checks.                                                                      |

Put a change in the module that already owns the responsibility. Split a module
when responsibilities actually diverge. Do not introduce repository/service/factory
layers or move core logic into `src-tauri/` to match a template.

## State and contracts

- Rust owns authoritative projects, artifact identity, simulation binding, jobs,
  filesystem access, and external process execution. React owns presentation and
  interaction state. Backend data in the UI is a view with a defined refresh path.
- Keep compilation/identity data independent of layout coordinates and UI state.
- Put native calls in `ui/api.ts` or a coherent extension of that boundary.
  Components call application operations; they must not assemble raw IPC details.
- Prefer named, typed operations and explicit payloads. A shared CLI/desktop
  transport is legitimate, but its accepted operations must be a closed validated
  set. Do not add arbitrary method dispatch or unrestricted executable commands.
- The current `api(action, args)` transport is existing implementation debt, not
  a reason to rewrite it during unrelated tasks. When extending that boundary,
  give the new operation concrete request/response types and backend validation.
- Keep boundary validation authoritative in Rust. Tauri capability configuration
  does not replace checks inside application-defined commands. Limit capabilities
  to those needed by implemented features.

## Invariants that simplification must preserve

- A simulation binds one waveform to one immutable snapshot and representation.
  An edited source or different stage must not silently reuse the old binding.
- Signal identity includes snapshot and instance context. Preserve bits, ranges,
  escaped names, aliases, and distinct delayed endpoints. Never guess a missing
  signal by basename or fabricate its value.
- Generate the gate schematic from the exact simulation netlist. Keep matching
  model/corner/SDF metadata with the run; simulation success does not imply clean
  timing, DRC, or LVS results.
- Selection propagation must prevent feedback loops and stale updates. Selection
  and cursor changes must not trigger graph layout.
- Do not modify optional upstream reference checkouts to implement application behavior.

## Jobs, resources, and scale

- Share tool execution and cancellation through the existing runner. Use argument
  arrays; escaping generated Yosys/Tcl/simulator text is a separate responsibility.
- Preserve reproducible inputs and logs. Publish successful artifacts atomically;
  failed/cancelled work must not appear as a completed snapshot.
- Keep long parsing, compilation, layout, and physical jobs off the UI thread and
  cancellable. Terminate owned process trees/containers/workers and release handles.
- Query visible waveform rows/time windows; bound graph exploration. Avoid whole
  trace/graph copies across IPC. Preserve timestamps as integers, with decimal
  strings at the JavaScript boundary when numbers would lose precision.
- Cache only with an explicit identity/invalidation rule. Reuse existing caches
  before adding another. Preserve snapshot/session isolation.
