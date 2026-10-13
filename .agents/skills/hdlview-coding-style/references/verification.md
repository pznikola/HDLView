# Verification and active configuration

## Verification

Run commands from the repository root, using installed/locked tools. Choose checks
for the affected code; a documentation-only task does not require the simulation
suite. Never invent a package script or fetch a new tool silently to run a check.

For Rust core/CLI changes:

```bash
cargo fmt --all --check
cargo clippy --workspace --exclude hdlview-desktop --all-targets -- -D warnings
cargo test --workspace --exclude hdlview-desktop
```

The core must also compile for Windows, where a Docker tool sees the workspace under
`/hdlview/work` instead of its host path. After changing how a path reaches a tool
or comes back from one, check the Windows target and run the affected real-tool
checks with that mapping forced on:

```bash
cargo check -p hdlview-core -p hdlview --tests --target x86_64-pc-windows-gnu
HDLVIEW_CONTAINER_PATHS=1 python3 tools/qualify.py --schematics --profile tools/profiles/docker.json
```

For desktop changes, include `hdlview-desktop` in Clippy/tests on a host with the
required GTK/WebKit development packages, or use the documented desktop build
container. An excluded desktop package is not a verified desktop package.
Do not enable all Cargo features blindly; test supported feature combinations.

For frontend changes:

```bash
npm run lint
npm run format:check
./node_modules/.bin/tsc --noEmit
npm test
npm run build
```

`npm run lint` is required for frontend changes. It checks `ui/` (including its
unit tests) and `vite.config.ts` with type-aware ESLint and React Hooks rules,
and fails on warnings. Browser tests and standalone tooling are not yet included
in this lint scope; they retain their own execution checks.

Use `npm run test:e2e` for changed cross-pane/user workflows with the native tool
profile described in the [project README](../../../../README.md#verification-and-packaging).
Tool-adapter changes need relevant real-tool fixtures where available. For Python
helpers, check syntax and run the affected helper fixture; compilation alone does
not verify the compiler/tool contract.

Use `npm run format:check` to check the repository's supported files. During an
implementation task, format changed files explicitly with the installed formatter:

```bash
./node_modules/.bin/prettier --write ui/components/Waveform.tsx
```

`npm run format` formats all supported repository files; use it for an intentional
formatting migration, rather than unrelated cleanup during feature work.

Inspect whitespace and the final diff. Remember that `git diff` does not include
untracked files; inspect new files too. Report missing prerequisites or existing
unrelated failures accurately without weakening checks.

## Active configuration

Maintain policy in these root files; the skill does not carry duplicate templates.

| File                                                                                                      | Responsibility                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [.editorconfig](../../../../.editorconfig)                                                                | UTF-8/LF, final newlines, two-space web files, four-space Rust/Python, and Makefile tabs.                                                              |
| [prettier.config.mjs](../../../../prettier.config.mjs) and [.prettierignore](../../../../.prettierignore) | Prettier defaults for code, 100-column Markdown, and exclusions for generated artifacts, raw qualification results, and verbatim license notices.      |
| [eslint.config.mjs](../../../../eslint.config.mjs)                                                        | Type-aware frontend/Vite checks, promise/type-import rules, and React Hooks checks.                                                                    |
| [tsconfig.json](../../../../tsconfig.json)                                                                | Strict typing, checked index access, explicit class overrides, switch fallthrough checks, and explicit type-only imports under verbatim module syntax. |

TypeScript's `strict` already includes unknown catch variables. These checks run
through the documented commands and build script; automated CI enforcement needs
an explicit pipeline step. Installed versions are pinned in `package-lock.json`.

Rust uses Cargo's formatter defaults and each crate's declared edition. There is
no custom `rustfmt.toml` or `clippy.toml`; Clippy warnings become errors through the
command above. The Rust toolchain is pinned in [rust-toolchain.toml](../../../../rust-toolchain.toml).

Activate new enforcement in a focused change using compatible locked tools and
address the affected diagnostics. Do not broadly suppress rules or add unchecked
assertions to make a new check pass.
