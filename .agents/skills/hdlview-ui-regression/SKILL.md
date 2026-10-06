---
name: hdlview-ui-regression
description: Reproduce and verify HDLView schematic/waveform interactions, navigation, session restoration, and asynchronous UI regressions using the existing Playwright-to-CLI harness. Use for behavioral UI changes, rather than copy-only edits or backend-only tool failures.
---

# HDLView UI regression

Work from the repository root and follow [the project rules](../../../AGENTS.md).
Use [workspace.spec.ts](../../../tests/workspace.spec.ts) and
[playwright.config.ts](../../../playwright.config.ts) as the existing interaction harness.
Read their current setup before changing the test.

## Reproduce the user action

1. Identify the action sequence and expected visible result, including selected
   snapshot/run and scope where relevant. Inspect the affected component, caller,
   and [UI API boundary](../../../ui/api.ts). For incorrect signal identities,
   also follow [cross-probing](../hdlview-cross-probing/SKILL.md).
2. Prepare the existing harness:

   ```sh
   cargo build -p hdlview
   HDLVIEW_TOOL_PROFILE=/absolute/configured-native-profile.json npm run test:e2e
   ```

   Replace the example path with an actual compatible profile; the checked-in native
   profile contains placeholders. Check installed Chromium before running. The
   project README documents browser installation when needed; do not use missing
   browser/tool prerequisites as a reason to replace the workflow with mocks.

3. Understand what this test exercises: it builds the counter design with the
   selected profile, starts a CLI `rpc` process, and exposes the test API bridge to
   the frontend. Playwright builds Vite in `e2e` mode and serves port 1420 itself.
   Do not start a second dev server or add a hosted backend. Simulation uses the
   profile captured in the built snapshot.
4. Reproduce through user-facing controls. Prefer role/label locators and assertions
   that wait for visible state or job completion. Inspect page errors and retained
   Playwright traces on failure; screenshots help explain visual failures but do
   not prove identity or binding correctness.

## Check the affected synchronization

- In [main.tsx](../../../ui/main.tsx) and [navigation.ts](../../../ui/navigation.ts),
  check selection origin/sequence, scope changes, restoration, and stale async results.
  Repeated selection in the same scope should not request a new graph view.
- In [Schematic.tsx](../../../ui/components/Schematic.tsx) and
  [layout.worker.ts](../../../ui/layout.worker.ts), check worker ownership, cancellation,
  cache identity, and the current view. Selection and cursor updates must not
  start another layout worker for an unchanged graph.
- In [Waveform.tsx](../../../ui/components/Waveform.tsx), distinguish visible-window
  transition queries from cursor value queries. A cursor update can request
  `wave_values`; it should not refetch an unchanged `wave_window`. Preserve visible
  row bounds, bus indices, X/Z values, and integer timestamp arithmetic.
- Keep genuine effect dependencies and clean up subscriptions, timers, workers,
  and stale requests. Do not suppress Hooks lint or add blanket memoization to
  hide a synchronization bug.

## Verify and finish

Use pure frontend tests for isolated selection/value logic and Playwright for the
changed cross-pane or restoration behavior. Extend the existing harness where it
fits; assert the failing user outcome. Its API-call and worker instrumentation can
also verify unnecessary expensive work without adding production instrumentation.
Avoid fixed sleeps, exact layout coordinates, and private call-order assertions.

Run the [frontend checks](../hdlview-coding-style/references/verification.md#verification) and relevant
browser workflow. Report what was exercised and any prerequisite failure. Passing
this harness verifies browser-to-core behavior; it does not qualify Tauri packaging,
desktop startup, or Linux distribution compatibility.
