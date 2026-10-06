# HDLView agent skills

Project skills live in `.agents/skills/` and provide task-specific workflows.
The [coding-style skill](../.agents/skills/hdlview-coding-style/SKILL.md) applies to
every application/tooling change through the root `AGENTS.md`, whether selected
automatically or not. Skills link existing guides and tools; they do not add
dependencies or authorize unrelated work.

| Skill                                                                     | Use it for                                                                                 | Explicit invocation        |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------- |
| [Coding style](../.agents/skills/hdlview-coding-style/SKILL.md)           | Minimal implementation, language conventions, architecture boundaries, review, and checks. | `$hdlview-coding-style`    |
| [Cross-probing](../.agents/skills/hdlview-cross-probing/SKILL.md)         | Signal identity, waveform binding, hierarchy/bus correspondence, and session isolation.    | `$hdlview-cross-probing`   |
| [Toolchain debugging](../.agents/skills/hdlview-toolchain-debug/SKILL.md) | Compiler, simulator, plugin, Docker, PDK, and LibreLane failures or adapter changes.       | `$hdlview-toolchain-debug` |
| [UI regression](../.agents/skills/hdlview-ui-regression/SKILL.md)         | Schematic/waveform interaction, navigation, asynchronous updates, and restoration.         | `$hdlview-ui-regression`   |

Codex discovers repository skills under `.agents/skills/`. Each description defines
when automatic selection is useful; explicit invocation is also available. Only
the selected skill's full instructions need to be read. If newly added skills do
not appear, restart the Codex session. Other agents can read the same `SKILL.md`
files directly; automatic discovery depends on the agent host.

Toolchain debugging has separate compilation, simulation, and physical-flow
references. Read only the relevant reference. No new helper scripts are included:
the CLI, Playwright harness, and qualification tools already provide the operations.
Performance and release-qualification skills remain deferred until needed.

## Activation and behavior examples

These are reusable evaluation cases, not measured selection results. Try them in
fresh sessions with the repository available. For tasks that change code, use an
isolated checkout with the same files and tool prerequisites. Compare the actual
skill selection, commands, and resulting behavior with the expected outcome.
Explicit prompts should load the named skill; implicit prompts should select the
relevant workflow. Copy and formatting cases use the coding rules without triggering
the three specialized diagnostic workflows; documentation-only cases need neither.
An identity defect involving the UI can appropriately use both cross-probing and
UI regression; the skills are not mutually exclusive.

| Case                      | Example prompt                                                                                                       | Expected behavior                                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Coding style, explicit    | “Use $hdlview-coding-style to fix unsafe JSON parsing without adding a validation dependency.”                       | Inspect the existing boundary, narrow unknown data, and run affected checks with a focused implementation.                     |
| Coding style, implicit    | “Fix this rejected UI promise and keep the change minimal.”                                                          | Handle the error at its owning boundary and follow existing TypeScript/React conventions without adding a new service layer.   |
| Coding style, review      | “Review this patch for unnecessary abstractions and missing error handling.”                                         | Review changed behavior and justified abstractions; preserve required validation and avoid unrelated cleanup.                  |
| Coding style, tooling     | “Enable an optional stricter TypeScript setting.”                                                                    | Inspect the active root configuration and address diagnostics in a focused migration.                                          |
| Cross-probing, explicit   | “Use $hdlview-cross-probing to investigate why clicking `first.count` reveals `second.count`.”                       | Trace the instance-aware identity and binding; reproduce the distinction between the two instances.                            |
| Cross-probing, implicit   | “The waveform declares `count[7:4]`, but the schematic selects the wrong bit. Fix the mapping.”                      | Inspect declared ranges and bit correspondence; add a regression for the incorrect offset.                                     |
| Cross-probing, contextual | “After restoring a session, a waveform from the mapped stage attaches to an elaborated snapshot.”                    | Inspect restoration and both snapshot/stage checks; prevent the incompatible attachment.                                       |
| Cross-probing, boundary   | “A dumped cell input and its driver differ briefly after SDF annotation. Should we merge their waveform identities?” | Preserve distinct endpoints; explain that interconnect delays can produce different simultaneous values.                       |
| Toolchain, explicit       | “Use $hdlview-toolchain-debug to diagnose a missing Slang plugin during an elaborated build.”                        | Inspect the selected profile, plugin load, generated frontend script, and command log; reproduce with the CLI.                 |
| Toolchain, implicit       | “`iverilog` compiles, but `vvp` fails to load its runtime library in Docker.”                                        | Inspect the actual container environment and library paths; validate the affected simulation.                                  |
| Toolchain, contextual     | “The VHDL source helper fails after a compiler change, although GHDL's version probe succeeds.”                      | Check compiler-matched Python bindings and run a source-helper fixture; do not treat the probe as compatibility proof.         |
| Toolchain, boundary       | “LibreLane produced a final netlist but artifact import failed. Recover the result.”                                 | Inspect structured state and captured artifacts; consider `resume-physical` without replacing a published snapshot.            |
| UI regression, explicit   | “Use $hdlview-ui-regression to verify that selecting a waveform reveals the matching schematic signal.”              | Exercise the existing real CLI/browser harness and assert selection in the correct instance.                                   |
| UI regression, implicit   | “Moving the waveform cursor starts another layout job and refetches all transitions.”                                | Inspect effect dependencies and distinguish value/window queries; verify no extra layout for the unchanged graph.              |
| UI regression, contextual | “Switching modules quickly lets an older view response overwrite the current schematic.”                             | Reproduce the navigation race and verify stale-response handling using observable state.                                       |
| Negative, copy            | “Change the Run simulation button label to Simulate.”                                                                | Make the focused copy edit and applicable routine checks; do not start toolchain qualification or browser-to-core diagnostics. |
| Negative, documentation   | “Fix a spelling mistake in README.md.”                                                                               | Edit the documentation without selecting these project workflows.                                                              |
| Negative, formatting      | “Format the changed CSS file using the existing formatter.”                                                          | Format only the requested file; do not compile HDL or inspect signal bindings.                                                 |

For runnable cases, verify the user-visible result or tool/artifact contract rather
than whether the answer repeats the skill wording. Record missing prerequisites
as limits, not passes. Improve descriptions or instructions when real use shows a
miss or unnecessary activation; avoid adding rules for hypothetical failures.

## Sources

- [Official skill authoring and repository discovery](https://learn.chatgpt.com/docs/build-skills).
- [Evaluating explicit, implicit, contextual, and negative skill cases](https://developers.openai.com/blog/eval-skills).
