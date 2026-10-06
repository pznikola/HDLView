# Research and adopted guidance

Reviewed 6 October 2026. These are primary/maintainer sources. The local guides
synthesize selected ideas for HDLView; they do not copy an entire external standard
or imply endorsement. Product-specific invariants come from the
[implementation plan](../../../../HDLView_IMPLEMENTATION_PLAN.md), not general style guides.

## Design and review

- [Google: what to look for in review](https://google.github.io/eng-practices/review/reviewer/looking-for.html).
  Basis for reviewing complexity, names, comments, and useful tests. Adopt solving
  demonstrated needs and questioning over-general code. Local rule: every new
  abstraction or option needs a concrete purpose, not a formal proposal.
- [Google: small changes](https://google.github.io/eng-practices/review/developer/small-cls.html).
  Adopt coherent changes that include their callers and checks. Do not turn the
  discussion of change size into a hard line-count limit or omit necessary work.

## Rust

- [Rust Style Guide](https://doc.rust-lang.org/style-guide/) and
  [API naming guidelines](https://rust-lang.github.io/api-guidelines/naming.html).
  Use automated formatting and familiar naming/conversions. Public-library API
  guidance does not require builder patterns, traits, or newtypes for every helper.
- [Clippy usage](https://doc.rust-lang.org/clippy/usage.html).
  Use focused diagnostics; extra lint groups require judgment. Local policy uses
  warnings as errors for the checked targets without enabling all lint groups.
- [Standard process API](https://doc.rust-lang.org/std/process/struct.Command.html).
  Pass executable arguments directly. Separately handle escaping required by
  generated tool scripts; argument arrays do not validate those scripts.

## TypeScript, React, and tooling

- [Google TypeScript guide](https://google.github.io/styleguide/tsguide.html).
  Adopt readable types, narrowing, and purposeful documentation. Do not import
  Google's internal tooling, every syntax preference, or blanket bans that conflict
  with this project's framework/formatter.
- [TypeScript strict](https://www.typescriptlang.org/tsconfig/strict.html) and
  [indexed access checking](https://www.typescriptlang.org/tsconfig/noUncheckedIndexedAccess.html).
  Distinguish the strict baseline from extra options. Static types do not validate
  external runtime values.
- [Rules of React](https://react.dev/reference/rules).
  Follow render purity, state immutability, and Hooks rules.
- [React: effects you may not need](https://react.dev/learn/you-might-not-need-an-effect).
  Derive display data from existing state and handle user actions in handlers.
  Keep effects for external synchronization. Local performance rules require a
  reason for memoization; do not assume the React Compiler is enabled here.
- [typescript-eslint: typed linting](https://typescript-eslint.io/getting-started/typed-linting/)
  and [ESLint configuration](https://eslint.org/docs/latest/use/configure/configuration-files).
  Scope type-aware presets and provide TS project information. The root configuration
  now activates these checks locally; CI enforcement requires an explicit pipeline step.
- [Prettier configuration](https://prettier.io/docs/configuration).
  Use a discovered or explicit configuration consistently; avoid formatting debates
  and unrelated reformatting.

## Boundaries, helpers, and testing

- [Tauri security model](https://v2.tauri.app/security/).
  Respect the frontend/Rust trust boundary. Local validation and narrow operations
  remain required even when desktop capabilities are configured.
- [PEP 8](https://peps.python.org/pep-0008/).
  Adopt Python naming, imports, indentation, and sensible consistency. Do not break
  compatibility or churn unrelated helpers to impose every preference.
- [Python subprocess API](https://docs.python.org/3/library/subprocess.html).
  Prefer argument lists, explicit exit-status handling, and appropriate resource
  management. Shell quoting is not interchangeable with generated-language escaping.
- [Testing Library principles](https://testing-library.com/docs/guiding-principles/).
  Prefer tests resembling observable use. This is testing guidance, not a requirement
  to add Testing Library or replace the existing test stack.

## Local decisions

The concrete abstraction threshold, scoped validation, contextual application errors,
minimal agent reporting, and HDLView artifact rules are project judgments. They are
not universal rules claimed by the sources above. Preserve necessary correctness
work even when it adds code; avoid quotas and speculative infrastructure.
