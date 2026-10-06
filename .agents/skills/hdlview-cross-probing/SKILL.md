---
name: hdlview-cross-probing
description: Diagnose or implement HDLView signal identity and schematic/waveform linking, including hierarchy, bus ranges, aliases, stage binding, and session restoration. Use when changing these contracts or investigating incorrect selections or values.
---

# HDLView cross-probing

Work from the repository root and follow [the project rules](../../../AGENTS.md).
Read [the identity and session contracts](../../../docs/ARCHITECTURE.md#identity-and-invariants)
and consult [current limitations](../../../docs/QUALIFICATION.md#remaining-limitations-and-release-gates)
before treating an unsupported mapping as an implementation bug.

## Trace the mismatch

1. Identify the selected snapshot, representation, run, and explicit testbench
   DUT scope. Check `snapshot.json`, `run.json`, and captured input/trace hashes.
   Imported trace provenance is user-declared; the waveform cannot prove its
   originating source revision.
2. Follow one failing signal through instance path segments, graph signal or
   endpoint ID, waveform declaration and declared range, `SignalBinding`, and
   frontend selection. Compare with a neighboring signal that behaves correctly.
   Inspect `status`, `evidence`, and `bit_correspondence`, not just the rendered label.
3. Locate the owning boundary:
   - [graph.rs](../../../crates/hdlview-core/src/graph.rs): occurrence IDs, ports,
     net aliases, and signal references.
   - [waveform.rs](../../../crates/hdlview-core/src/waveform.rs): DUT-root mapping,
     declaration/range matching, and manual bindings.
   - [service.rs](../../../crates/hdlview-core/src/service.rs): run opening,
     binding persistence, and session validation.
   - [selection.ts](../../../ui/selection.ts), [navigation.ts](../../../ui/navigation.ts),
     and [main.tsx](../../../ui/main.tsx): selection propagation and revealing scopes.
4. Reproduce with a small fixture and fix the owning rule. For backend inspection,
   use CLI `view`/`wave`, or `rpc` operations `open_snapshot`, `open_run`, `wave_info`,
   and `bindings`; read their actual payloads in `service.rs` before invoking them.
   CLI scope flags split on dots: use RPC arrays when an identifier itself contains
   dots. Preserve original path segments throughout the fix.

## Preserve the contract

- Require both snapshot and representation to match. Never attach an existing
  waveform to a new stage automatically or edit captured inputs to make it match.
- Keep instance occurrences and module definitions distinct. Yosys bit numbers
  are module-local; waveform storage aliases do not erase declaration paths.
- Resolve exact declarations and validated ranges. Do not introduce basename or
  fuzzy matching. Keep `missing`, `ambiguous`, `range_mismatch`, and `out_of_scope`
  distinguishable; unavailable signals have no invented value.
- Apply VHDL case rules only where appropriate. Preserve escaped spelling, range
  direction, offsets, and bit correspondence. Current manual mappings require
  compatible ranges; do not imply arbitrary slice remapping already works.
- Preserve separate cell-pin identities for SDF interconnect delays, even when
  their electrical nets are connected. Retain integer timestamps across IPC.
- Keep incoming selections from being re-emitted as new user actions. Selecting a
  module reveals its scope; selecting a cell exposes its pins. Cursor movement and
  signal selection within the existing view must not request another layout.

## Verify and finish

Use [identity.rs](../../../crates/hdlview-core/tests/identity.rs) for backend identity
regressions and [selection.test.ts](../../../ui/selection.test.ts) for selection/value
logic. Cover the failing distinction, such as repeated instances, a range offset,
or a missing dump, without asserting generated names or layout coordinates.

For changes to user interaction or restoration, also exercise
[workspace.spec.ts](../../../tests/workspace.spec.ts) using
[the UI workflow skill](../hdlview-ui-regression/SKILL.md). Run the applicable checks
from [the coding guide](../hdlview-coding-style/references/verification.md#verification).
Report the resolved identity/binding behavior and any remaining unavailable signals.
