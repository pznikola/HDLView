# Coding style

The objective is correct, readable code with as few moving parts as the current
requirements allow. **Must** identifies a correctness or project requirement;
**prefer** is a default that may yield to a concrete reason. Formatting belongs
to tools. This guide does not impose function lengths, file lengths, coverage
percentages, or abstraction quotas.

## Small, complete changes

- Solve the requested behavior, including relevant failure paths. Do not add
  speculative features, extension points, configuration switches, or placeholders.
- Prefer an existing function, a direct expression, or a plain data structure.
  Add a helper when it names a meaningful operation, isolates a boundary, or
  makes difficult code easier to follow—even if used once.
- Do not create a class, trait, factory, service, registry, or hook merely to wrap
  one call. A thin adapter is justified when it owns a real contract or boundary.
- Share code when callers share the same rule and should change together.
  Similar-looking code with different reasons to change may stay separate.
  Do not create a generic utility to remove a few incidental repeated lines.
- Add a dependency only when it removes meaningful implementation or maintenance
  work. Check the existing stack, compatibility, license, and runtime cost; update
  the lockfile. Do not reimplement a complex parser just to avoid a dependency.
- Remove code made obsolete by your change. Do not retain commented-out code,
  unused exports, unreachable branches, or compatibility paths without a supported
  caller or documented format/version requirement.
- Optimize with evidence or an explicit workload constraint. Do not add caching,
  concurrency, or memoization by habit. Every cache needs an invalidation rule;
  every background operation needs an owner and a termination path.

## Readability and comments

- Name things for their domain meaning. Established terms such as RTL, SDF, AST,
  and IPC are appropriate; vague names such as `data2` or `Manager` hide intent.
- Keep functions responsible for one coherent operation. Prefer straightforward
  control flow and early returns over deep nesting or clever expressions.
- Keep helpers and types near their users until there is a reason to share them.
  Avoid single-function files, barrel exports, and deep directory trees by default.
- Comment invariants, units, non-obvious algorithms, tool quirks, and tradeoffs.
  Document public contracts when their use or failure behavior is not obvious.
  Do not narrate each statement, repeat the type signature, or add banner comments.
- A TODO must identify concrete unfinished work and its context. Do not add
  aspirational TODOs or a separate design document for routine changes.

## Boundaries and errors

- Must validate external data at its owning boundary: files, IPC, subprocess
  output, configuration, and persisted artifacts. Check semantics as well as
  shape: ranges, paths, identities, sizes, and allowed transitions.
- After validation, use a meaningful internal type. Do not repeatedly revalidate
  the same invariant in every helper. Frontend checks improve feedback; privileged
  backend operations must still enforce their own constraints.
- Must preserve failures. Do not replace parse errors with empty collections,
  invent defaults for required fields, catch and ignore errors, or silently switch
  tools. Recovery needs an explicit supported behavior.
- Add context where it becomes available. Report an error once at the responsible
  boundary; avoid logging and rethrowing the same failure through every layer.
  Include useful tool/path/job context without leaking secrets.
- Keep cleanup and cancellation explicit. Use scoped resource management, close
  handles, release listeners, and prevent stale work from publishing new state.

```rust
// An unreadable project must not become a seemingly valid empty project.
let text = std::fs::read_to_string(path)
    .with_context(|| format!("reading project {}", path.display()))?;
```

## Rust

- Use `rustfmt`, idiomatic names, and the crate's declared edition. Types and
  traits use `PascalCase`; functions/modules use `snake_case`; constants use
  `SCREAMING_SNAKE_CASE`. Keep visibility as narrow as callers allow.
- Return `Result` for recoverable failures. Use a typed error when callers need
  to distinguish cases; contextual `anyhow::Result` is appropriate for application
  orchestration. Do not create a one-variant error hierarchy for every function.
  Convert errors into the documented IPC form at the adapter boundary.
- Must not use `unwrap`/`expect` on user input, file data, or ordinary runtime
  failures. They are acceptable in tests and for demonstrable internal invariants;
  explain an invariant if construction does not make it apparent.
- Borrow when ownership is unnecessary. Do not clone large graphs or traces to
  avoid understanding ownership. Do not add `Arc<Mutex<_>>` without a real sharing
  requirement; avoid holding a lock across I/O or an await.
- Use enums for mutually exclusive states and newtypes where mixing identifiers
  or units would cause errors. Do not wrap every primitive mechanically.
- Prefer concrete functions/types. Introduce traits or generics for actual shared
  behavior, a useful boundary, or a required variation—not hypothetical providers.
- Prefer standard conversion traits and familiar `as_`, `to_`, `into_` naming.
  Must document and justify any new `unsafe` block's safety invariants.
- Do not broadly suppress Clippy or enable every pedantic/restriction lint.
  A necessary suppression must cover the smallest scope and explain the reason.

## TypeScript

- Must retain `strict` checking. Prefer inference for obvious local values and
  explicit types for public contracts or non-obvious return values.
- Use `unknown` and narrowing for unchecked values. A type assertion or
  `invoke<T>()` does not validate runtime data. Do not use `any`, non-null assertions,
  double casts, or suppression comments to conceal a real contract mismatch.
  Isolate unavoidable third-party typing workarounds with a reason.
- Use discriminated unions for states with different valid payloads. Avoid
  combinations of booleans that permit impossible states.
- Treat shared records as immutable; use `readonly` when it makes ownership clear.
  Local mutation during construction is fine. Do not spread/copy large collections
  on every iteration merely to look immutable.
- Must handle rejected promises: await/return them to a caller that handles errors,
  or catch them at the event boundary. `void promise` alone does not handle failure.
- Keep optional values optional only when absence has a defined meaning. Avoid
  defensive `?.`/`??` chains that mask broken required fields.
- Components/types use `PascalCase`; functions/variables use `camelCase`.
  Keep transport field spelling consistent with the declared wire format.

## React

- Use function components and follow the Rules of Hooks. Must keep rendering pure
  and must not mutate props or state.
- Store the minimum state; derive the rest during render. Keep state near its
  owner. Do not copy every backend field into separately mutable frontend state.
- Use event handlers for user actions. Use effects to synchronize with external
  systems; clean up subscriptions/timers and cancel or ignore stale async results.
  Must not suppress effect dependencies to hide a synchronization problem.
- Extract components/hooks for a coherent responsibility or meaningful reuse.
  Straightforward rendering conditions and event handlers may stay in a component.
  Heavy parsing, domain rules, and native-call details belong outside it.
- Add `useMemo`, `useCallback`, or `memo` for measured cost or a required stable
  identity, not to every calculation/function. Memoization must not be required
  for correctness.
- Preserve keyboard access, labels, focus behavior, and stable list keys when
  changing controls. Use semantic HTML where possible.

```tsx
// Derive this from existing state; no second state variable or effect is needed.
const selectedSignal = signals.find((signal) => signal.id === selectedId);
```

```tsx
function handleRun() {
  void startSimulation(request).catch(reportError);
}
```

## Python and shell helpers

- Follow PEP 8 naming, imports, and four-space indentation; preserve the local
  formatter convention. Use functions and standard-library facilities before
  adding classes or a framework. Type non-obvious helper contracts when useful.
- Catch specific expected exceptions near the recovery point. Use context managers
  for resources. Keep machine-readable stdout separate from stderr diagnostics.
- Run tools with argument lists (`subprocess.run([...], check=True)` when failure
  is exceptional). Must not interpolate project input into a shell command.
  In shell scripts, quote variable expansions and check relevant exit statuses.
- Keep HDL fixtures small and valid for their declared dialect. Derive HDL behavior
  from supported compiler APIs; do not introduce a regex HDL parser.

## Tests and completion

- Test externally observable behavior and important invariants. For a bug, prefer
  a small regression case that fails with the original behavior.
- Select the cheapest useful level: pure-logic tests, boundary/adapter integration
  tests, and a few end-to-end tests for complete interactions. Test realistic error
  paths where they affect correctness; mock expensive boundaries, not all internals.
- Do not add tests for unchanged trivial forwarding, exact private call sequences,
  arbitrary compiler names, or layout coordinates. Documentation/formatting-only
  changes need relevant checks, not new application tests.
- Must not weaken assertions, delete failing tests, or broaden snapshots just to
  make checks pass. Use deterministic fixtures; avoid sleeps as synchronization.
- Update affected contracts, callers, fixtures, and usage documentation together.
  Do not break persisted formats or public APIs without handling the migration or
  explicitly communicating an authorized breaking change.
- Inspect the final diff and run the applicable checks in [verification.md](verification.md).
  Report the outcome and material limitations concisely.
