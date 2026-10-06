---
name: hdlview-coding-style
description: Implement, fix, review, or refactor HDLView code using the smallest complete, correct change and the project's Rust, TypeScript, React, and Python conventions. Use for application/tooling changes and lint or formatter configuration; avoid unrelated cleanup and speculative abstractions.
---

# HDLView coding style

Make the smallest complete, correct change that satisfies the request. Minimize
concepts and maintenance burden, not characters. Necessary validation, cleanup,
error handling, and meaningful verification are part of the implementation.

The [root AGENTS.md](../../../AGENTS.md) requires this workflow for application and
tooling changes, even when automatic skill selection does not occur. User/task
requirements take precedence. Upstream guides explain the local rules; they are
not additional blanket requirements.

## Read only what the change needs

- Read [style.md](references/style.md) before implementation; focus on the shared
  rules and the languages being changed.
- Read [architecture.md](references/architecture.md) when changing ownership,
  interfaces, jobs, or data flow. Keep compiler, snapshot, and waveform authority
  in the Rust core and presentation state in the UI.
- Use [verification.md](references/verification.md) to select checks and understand
  which root configurations are active. Change enforcement in a focused migration
  and address its diagnostics without weakening checks.
- Use [review.md](references/review.md) for the final review, without creating a
  checklist file or mandatory report for each task.
- Consult [sources.md](references/sources.md) only when the basis of a rule matters.
  Do not load all upstream guides for an ordinary edit.

## Implement and review

1. Inspect the affected code, callers, tests, and installed tool versions. Reuse
   an existing operation before adding one.
2. Identify required behavior and invariants. For a simple task, do this directly;
   do not create a plan document or scaffolding by default.
3. Implement in the existing structure. Add an abstraction, dependency, option,
   or fallback only for a concrete requirement in this task.
4. Keep unrelated refactoring, renaming, formatting, and dependency upgrades out
   of the change. Preserve the user's other work and optional upstream checkouts.
5. Review the diff for removable code, stale comments, duplicate state, swallowed
   errors, and unnecessary indirection. Inspect new files as well as tracked diffs.
6. Run applicable checks and report what actually ran and any limits. Never describe
   a proposed command or unsupported workflow as a passed check.

Apply mandatory rules to new and materially changed code. Existing violations
do not authorize a repository-wide rewrite. Follow nearby conventions where the
guides leave a choice open. Keep justified exceptions narrow and explain them
where they matter; ordinary implementation choices do not require separate approval.
