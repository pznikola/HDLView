# HDLView

Linux desktop HDL schematic and waveform explorer, with a Rust core and headless CLI.

- Source/dataflow, elaborated RTL, generic gates, PDK-mapped gates, and post-layout views.
- Verilog/SystemVerilog projects, using existing open-source compilers.
- File-menu project creation/opening, grouped RTL/simulation imports, editable source tabs, and automatic project artifact restoration.
- Live syntax, semantic, and style diagnostics for unsaved design and simulation buffers.
- Bidirectional schematic/waveform selection, instance-aware signal identities, bus expansion, and exact integer timestamps.
- Icarus and Verilator simulation; VCD/FST import through Wellen.
- SKY130 and IHP LibreLane flow integration, reports, final netlists, and SDF delay simulation.
- Native executable profiles or Docker, immutable inputs, command manifests, logs, cancellation, and session restoration.

**A waveform belongs to exactly one snapshot and representation.** Closing a waveform session permits stage changes. Imported traces require an explicit DUT scope; file formats alone cannot prove which sources produced them.

This is version 0.1.0. Read [qualification and remaining limitations](docs/QUALIFICATION.md) before interpreting timing or physical results. Icarus does not provide complete timing-check coverage. A successful simulation does not imply clean DRC, LVS, or STA.

## Setup

Install Node.js 22.12+ and Rust 1.90 (selected by `rust-toolchain.toml`). For native desktop development on Ubuntu 22.04/24.04:

```sh
sudo apt-get install build-essential pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf
npm ci --legacy-peer-deps
cargo build -p hdlview
npm run desktop
```

If startup aborts with `Could not create GBM EGL display: EGL_NOT_INITIALIZED`,
try WebKit's DMA-BUF renderer workaround for that launch:

```sh
WEBKIT_DISABLE_DMABUF_RENDERER=1 npm run desktop
```

This bypasses the affected rendering path; it does not repair the graphics driver.
See the [upstream WebKit workaround report](https://bugs.webkit.org/show_bug.cgi?id=280210).
For Linux development hosts that still show EGL initialization warnings or GTK
free-space warnings for private Docker mounts, use the compatibility launch:

```sh
npm run desktop:compat
```

This sets the DMA-BUF workaround, [Mesa software rendering](https://docs.mesa3d.org/egl.html),
and [GIO's Unix volume monitor](https://docs.gtk.org/gio/overview.html) for that launch.
Software rendering uses the CPU. The volume-monitor override is a development
troubleshooting option; desktop-managed drives/network locations may appear
differently in the native picker. The Docker directory remains protected.

The Rust `tauri` crate and JavaScript `@tauri-apps/api` must share a major/minor
version. Keep their pins aligned when updating dependencies.

The tools are separate from the desktop application. Build the qualified derived image:

```sh
docker build -f tools/Dockerfile -t hdlview-tools:2025.12 .
```

The base image alone supports many compilation tasks, but **does not provide the complete qualified physical toolchain**. The derived image pins pyslang, LibreLane 3, and Magic. Its LibreLane profile intentionally bypasses the base image's legacy LibreLane 2 wrapper to use the matching newer OpenROAD and OpenSTA binaries.

Open `examples/counter/hdlview.project.json` or `examples/verilog/hdlview.project.json`. The default desktop profile matches [tools/profiles/docker.json](tools/profiles/docker.json). Select a representation, build, then run a simulation.

Use **File → Create New Project…** to choose a name, directory, and **SKY130** or **IHP SG13G2** technology. Add files, folders, or `.f`/`.flist` inputs, review them, then finish with **Create New Project**. Files stay in their original locations; cancelling the wizard writes no configuration. Empty projects can be created. Set the top in **Project Settings** before building; mapped/physical builds also require a clock port and period.

**File → Add New Files…** adds Verilog/SystemVerilog inputs to **Design Sources** or **Simulation Sources**. Both RTL and gate runs use the same registered testbench files; gate runs compile the exact exported Verilog netlist. Headers remain separate from compilation units. The Sources explorer preserves directories under each group; right-click an imported folder/filelist (or use Shift+F10) to rescan/reimport. Configure the chosen simulation's top, DUT scope, and ordered testbench inputs in Project Settings' advanced JSON; registering a simulation file does not invent a testbench configuration.

**File → Save Project** saves edited documents, project configuration, and current artifact references. `Ctrl+S` saves the active file; `Ctrl+Shift+S` saves the project. External edits offer Reload/Overwrite/Cancel. Closing a dirty tab/project/window offers Save/Discard/Cancel. Sources must be saved before building. Saved edits mark the schematic **Rebuild required**; captured source navigation remains read-only with a separate working-file action. UTF-8 BOM and LF/CRLF are preserved; unsupported encodings, mixed line endings, and CR-only files are reported.

Drag the horizontal divider above Waveforms to resize its height. Focus the divider and use Up/Down to adjust it, or Home/End for the limits. The editor and schematic share the remaining space.

**File → Open Existing Project…** selects JSON using the native picker and automatically reopens that project's last valid schematic and matching waveform. There is no separate Restore Session command. Restoration is local to this machine and the configuration's canonical path; tabs, pane sizes, scope, waveform cursor/zoom, and row selection start with defaults. Missing/corrupted artifacts produce warnings; changed working inputs retain the old immutable schematic with a rebuild indication. Opening never compiles or simulates automatically. **Close Project** leaves sources and artifacts on disk.

Registered external roots appear as `@root/path`; include settings accept project-relative paths or that notation. Folder rescans preserve manual compilation order; filelist reimports apply reviewed order and retain source/header roles. Version-1 and version-2 Verilog/SystemVerilog configurations load without automatic rewriting. Their RTL/gate source lists merge in memory, preserving order and configuration-specific testbench lists. Explicit Save Project writes schema 3 without language-family, source-library, gate-source, or simulation-stage fields. Existing VHDL projects are unsupported and opening one leaves the current workspace intact. Legacy valid SV artifacts remain immutable and may show Rebuild required after migration.

For a native installation, adapt [native.example.json](tools/profiles/native.example.json) in the Toolchain editor. Set plugin paths and relevant environment variables as well as executables. The Python environment must contain `pyslang==10.0.0` (needed to honor Verilog-2005 source-view settings). Standard-cell interface extraction also uses `pyslang`.

## Live editor diagnostics

Working Verilog/SystemVerilog files are checked after 750 ms without typing, using
pyslang 10.0.0 for project correctness and Verible for style. Unsaved buffers,
including open headers, are analyzed in temporary copies. Typing and linting do
not change originals, create snapshots, or mark the schematic for rebuilding.
Checks pause during other jobs. Captured snapshot and auxiliary tabs are excluded.

Errors and warnings appear as underlines, gutter markers, and hover messages with
the engine and diagnostic code. Open **Problems** beside **Logs** for the full list;
click an entry to select its working-source range. F8/Shift+F8 navigate diagnostics
in the active editor. Linting does not open the drawer or move the cursor.

Design analysis uses working project settings. Simulation files use the selected
owning configuration or their unique owner; **Lint simulation configuration**
resolves multiple owners. Missing tops/configurations and unreferenced headers
show **Limited analysis**. Generated gate netlists, cell models, and SDF are not
part of this working-source check. Icarus uses SystemVerilog-2012 while Slang 10
supports SystemVerilog-2017/2023; this difference is reported as limited analysis,
and actual simulator compilation remains authoritative.

**Project Settings** has **Live linting** and **Style checks** toggles. They are
machine-local, keyed by canonical project path, and do not change project JSON or
build fingerprints. The default style rules are `no-trailing-spaces`, `posix-eof`,
`forbid-consecutive-null-statements`, `module-port`, and `module-parameter`.
A `.rules.verible_lint` beside `hdlview.project.json` replaces this preset using
[Verible's configuration syntax](https://github.com/chipsalliance/verible/blob/dec56671f8aa63a77b687b4df9753de451582b53/verible/verilog/tools/lint/README.md).
Existing inline waivers work; formatting and automatic fixes are not enabled.

The qualified Docker image includes Verible `v0.0-3724-gdec56671`. Native users set
`verible-verilog-lint` and Python executable paths in Toolchain. Probe checks both
the binary and the actual pyslang API. Missing tools or invalid rule files are
reported as engine failures and do not prevent editing or building. Each engine
has a maximum 10-second timeout; results are capped at 1,000 diagnostics. Only
the latest lint logs remain under `editor-lint/logs` in the application cache.

**Style checks incomplete** means Verible could not finish checking the input,
often because of an RTL syntax error. Slang diagnostics remain available.
**Style checks unavailable** identifies a failed style engine; **Limited analysis**
remains the status for restricted semantic checking.

Live linting and new builds use the configured Toolchain profile. Opening or
restoring a schematic does not replace that profile; simulation of an existing
snapshot retains its recorded toolchain. **Correctness checks unavailable** means
Slang failed to run, so syntax and name errors cannot be checked. For a pyslang
version mismatch, select `hdlview-tools:2025.12` in Toolchain and rebuild that image
from `tools/Dockerfile` if needed. Native users install `pyslang==10.0.0` into the
Python environment selected by their profile.

## Headless workflows

```sh
cargo run -p hdlview -- --profile tools/profiles/docker.json build examples/counter/hdlview.project.json --representation elaborated
# The JSON result includes directory and id.
target/debug/hdlview simulate /absolute/artifact/directory/snapshot.json --configuration rtl
target/debug/hdlview view /absolute/artifact/directory/snapshot.json --scope counter.first
target/debug/hdlview wave /absolute/path/trace.vcd
```

Representations: `source`, `elaborated`, `generic`, `mapped`, `post_layout`.

```sh
target/debug/hdlview --profile tools/profiles/docker.json build examples/counter/hdlview.project.json --representation post_layout
target/debug/hdlview simulate /absolute/artifact/directory/snapshot.json --configuration timing
```

`--store` selects the artifact root; the CLI defaults to `.hdlview`. Desktop artifacts use the OS application cache directory. `resume-physical DIRECTORY` retries collection of final physical artifacts when compilation/import failed before a snapshot was published. Existing snapshots are never overwritten by this command.

Use **named port connections in gate testbenches**: physical tools may reorder declarations. Use one ordinary simulation configuration for RTL or gates; the selected snapshot chooses the DUT implementation. Test public interfaces: RTL-internal probes or DUT parameter overrides may need adjustments after synthesis. Configurations with SDF remain gate-only and require Icarus. `timing_corner` selects the exported SDF file, while `delay_selection` independently chooses `min`, `typ`, or `max`. OpenSTA's exported sparse triples use `max` by default; a missing selected value is an annotation error, not an assumed zero delay.

`hdlview rpc` is a local JSON-lines interface used by tests, sharing the same application service as Tauri. It is not a network service. See [architecture](docs/ARCHITECTURE.md).

## Verification and packaging

```sh
cargo test --workspace --exclude hdlview-desktop
cargo clippy --workspace --exclude hdlview-desktop --all-targets -- -D warnings
npm run lint
npm run format:check
npm test
npm run build
npx playwright install chromium
HDLVIEW_TOOL_PROFILE=/absolute/native-profile.json npm run test:e2e
```

The browser test compiles a real hierarchical design and simulates it through the CLI service. `tools/qualify.py` runs a repeatable shared-testbench matrix; `--mapped` adds both PDKs, `--physical` adds full flows, and `--store` keeps provider reports separate; `tools/benchmark.py --mib 1024` measures large-VCD parsing. `node tools/benchmark-layout.mjs` and `python3 tools/benchmark-values.py` measure browser layout and cached cursor queries.

`python3 tools/qualify-editor-lint.py --profile tools/profiles/docker.json`
checks real diagnostics, unsaved inputs, rule configuration, and temporary-copy
cleanup. Use a configured native profile and a separate `--store` to compare
providers. Browser qualification measures end-to-end editor feedback including
debounce; backend matrix timings measure input preparation and engines only.

With host desktop development libraries, `npm run package` invokes Tauri packaging. An isolated Ubuntu 22.04-compatible Debian package can instead be built with:

```sh
bash tools/package-linux.sh
# target/packages/hdlview_0.1.0_amd64.deb
# Optional smoke check after packaging: python3 tools/smoke-package.py
sudo apt install ./target/packages/hdlview_0.1.0_amd64.deb
```

The package includes both `hdlview-desktop` and `hdlview`. HDL tools and PDKs are supplied through a configured profile. Docker is required on the host when using a Docker profile; no Docker socket is mounted inside tool containers.

The current workspace demonstration is shown in [this screenshot](docs/workspace.png).

See [implementation specification](HDLView_IMPLEMENTATION_PLAN.md), [dependency notices](docs/DEPENDENCIES.md), and [qualification evidence](docs/QUALIFICATION.md).

The [visualization research](docs/research/rtl_visualization_tools.md) records the
reference projects and inspected revisions. Their source checkouts are optional
and are not required to build or run HDLView. Installed dependencies, build outputs,
waveform artifacts, and local caches are excluded from Git; build commands generate
the ELK files under `public/vendor/` from the pinned package.

For agent workflows, see [project skills](docs/AGENT_SKILLS.md) and
[hdlview-coding-style](.agents/skills/hdlview-coding-style/SKILL.md).

EditorConfig, Prettier, ESLint, and TypeScript settings are active at the repository
root. Run `npm run format` to apply formatting and `npm run format:check` to check it.
The formatter excludes generated artifacts, qualification result files, and verbatim
third-party notices. Rust uses Cargo's standard formatter and Clippy checks.
