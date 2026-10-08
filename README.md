# HDLView

Linux desktop HDL schematic and waveform explorer, with a Rust core and headless CLI.

- Source/dataflow, elaborated RTL, generic gates, PDK-mapped gates, and post-layout views with hardware symbols.
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

Open `examples/00_mux/hdlview.project.json` for a small first design, or
`examples/04_adder_N/hdlview.project.json` for a hierarchical adder. All 18
[SystemVerilog examples](examples/README.md) have ready-to-run project and simulation
settings. The default desktop profile matches [tools/profiles/docker.json](tools/profiles/docker.json).
Select a representation, build, then run the **rtl** simulation configuration.

Use **File → Create New Project…** to choose a name, directory, and **SKY130** or **IHP SG13G2** technology. Add files, folders, or `.f`/`.flist` inputs, review them, then finish with **Create New Project**. Files stay in their original locations; cancelling the wizard writes no configuration. Empty projects can be created. Set the top in **Project Settings** before building; mapped/physical builds also require a clock port and period.

**File → Add New Files…** adds Verilog/SystemVerilog inputs to **Design Sources** or **Simulation Sources**. Both RTL and gate runs use the same registered testbench files; gate runs compile the exact exported Verilog netlist. Headers remain separate from compilation units. The Sources explorer preserves directories under each group; right-click an imported folder/filelist (or use Shift+F10) to rescan/reimport. Configure the testbench in **Project Settings → Simulation**; registering a simulation file does not invent a configuration.

**Project Settings** groups controls into **General**, **Sources**, **Simulation**, **Physical Design**, and **Editor**. General sets the design top, language standard, and technology. Sources controls compilation order, includes, defines, and design parameters. Physical Design sets clocks, SDC, utilization and density; the standard-cell preset follows technology. Only uncommon LibreLane overrides need optional JSON.

For the counter example, choose **Simulation → Add Simulation Configuration**, leave **Icarus** selected, enter **Testbench top module** `tb` and **DUT instance path** `tb.dut`, and select `tb.sv`. The path begins with the testbench top and names its counter instance. Simulation duration defaults to 1 µs. **Add Simulation Sources…** imports files without discarding settings edits. Named configurations can be duplicated, renamed or deleted; Advanced exposes simulation defines, literal runtime arguments, gate models and SDF choices. SDF requires Icarus and a matching gate snapshot.

**Apply** updates the working project and leaves the dialog open; **OK** applies and closes. **Cancel**, Escape and the close button discard changes since the last successful Apply. Use **File → Save Project** to persist applied settings. Apply does not build, simulate, or save source buffers. After changing captured settings, rebuild the schematic before running simulation; the existing waveform remains bound to its original snapshot. Missing setup has a **Configure** shortcut, including the linter's missing simulation context.

The Sources explorer shows registered entries with file/folder icons, selection, active-file highlighting, and dirty/missing indicators. Use **File → New File…** (`Ctrl+N`) or the New File/New Folder heading icons. Design files default to `rtl/`, simulation files to `sim/`; folder context actions use that folder, and the directory picker can select an external destination. New `.v`/`.sv`/`.vh`/`.svh` files are empty and open in the editor. Headers register an include directory. New folders remain visible after Save Project/reopen without automatically importing their contents. No top or simulation configuration is inferred.

Right-click an entry (or press `Shift+F10`) for **Rename**, **Remove from Project**, and **Move to Trash**. Arrow keys navigate the tree, Enter opens a file, and `F2` renames it. Renaming preserves open buffers and history, and updates project references; HDL include strings and filelist contents require manual correction. Removing membership leaves originals on disk and records persistent import exclusions; explicitly selecting an excluded entry in a later import review re-adds it. Moving to Trash uses the original host file even with a Docker toolchain. Folder Trash is blocked by unregistered files, including hidden entries. Project/root headings and internal artifacts cannot be renamed or trashed.

Disk creation, rename, and Trash happen immediately; **Save Project** persists the updated membership. **Discard does not undo those disk operations.** Modified tabs offer Save/Discard/Cancel before removal or Trash. Linux Trash requires `/usr/bin/gio` from `libglib2.0-bin`; install that package for native/AppImage use. The Debian package declares it. Trash failures do not fall back to permanent deletion. Restoring from desktop Trash is handled by your file manager, followed by an explicit re-add if needed.

**File → Save Project** saves edited documents, project configuration, and current artifact references. `Ctrl+S` saves the active file; `Ctrl+Shift+S` saves the project. External edits offer Reload/Overwrite/Cancel. Closing a dirty tab/project/window offers Save/Discard/Cancel. Sources must be saved before building. Saved edits mark the schematic **Rebuild required**; captured source navigation remains read-only with a separate working-file action. UTF-8 BOM and LF/CRLF are preserved; unsupported encodings, mixed line endings, and CR-only files are reported.

Use **Sources**, **Design**, and **Inspector** to choose the left sidebar view. Selecting a schematic object updates its inspection details without switching the sidebar. The editor and schematic share the area beside it and can be hidden independently.

**Waveforms**, **Logs**, and **Problems** share a panel across the full window width. Choose a tab to open it, or use its collapse button to give the upper panes more space. A successful simulation opens Waveforms. Switching tabs preserves waveform rows, cursor, zoom and radix; each view scrolls independently. Drag the sidebar, editor, or bottom-panel dividers to resize them. Focus a divider and use arrow keys, or Home/End for its limits. The sidebar stays between 224 and 420 pixels, leaving at least 360 pixels beside it on supported window sizes. The bottom panel defaults to 35%, with a 140-pixel minimum and limits that leave at least 260 pixels above it. The editor/schematic split stays within 20–80%, reserving 200/320 pixels respectively when space permits. Pane sizes start with defaults when reopening a project.

**File → Open Existing Project…** selects JSON using the native picker and automatically reopens that project's last valid schematic and matching waveform. There is no separate Restore Session command. Restoration is local to this machine and the configuration's canonical path; tabs, pane sizes, scope, waveform cursor/zoom, and row selection start with defaults. Missing/corrupted artifacts produce warnings; changed working inputs retain the old immutable schematic with a rebuild indication. Opening never compiles or simulates automatically. **Close Project** leaves sources and artifacts on disk.

Registered external roots appear as `@root/path`; include settings accept project-relative paths or that notation. Folder rescans preserve manual compilation order; filelist reimports apply reviewed order and retain source/header roles. Version-1 and version-2 Verilog/SystemVerilog configurations load without automatic rewriting. Their RTL/gate source lists merge in memory, preserving order and configuration-specific testbench lists. Explicit Save Project writes schema 3 without language-family, source-library, gate-source, or simulation-stage fields. Existing VHDL projects are unsupported and opening one leaves the current workspace intact. Legacy valid SV artifacts remain immutable and may show Rebuild required after migration.

For a native installation, adapt [native.example.json](tools/profiles/native.example.json) in the Toolchain editor. Set plugin paths and relevant environment variables as well as executables. The Python environment must contain `pyslang==10.0.0` (needed to honor Verilog-2005 source-view settings). Standard-cell interface extraction also uses `pyslang`.

## Schematic workspace

The schematic uses gate, mux, register, arithmetic, memory and directional-port symbols.
Open a module with its expansion button or double-click it. For a new Source RTL build,
processes, functions and tasks open captured behavioral details; **Back to parent schematic**
restores the previous camera. Dashed edges mean source dependencies and dotted edges mean
procedural control. Unsupported constructs remain labeled and diagnosed; source behavior
is not a physical gate diagram. Function arguments and expression temporaries without
simulator declarations remain unavailable.

Elaborated RTL can compact complete mux trees, decoders and priority encoders. Open those
symbols to inspect original compiler nodes. Selecting a dumped internal signal in Waveforms
opens its containing group. Symbols inspect objects; clicking pins/wires selects signals.
Inputs align on the left and outputs and inouts on the right; their vertical order
follows the logic they connect to. Data, clock, enable, select and synchronous reset
pins enter a symbol on the left; only an asynchronous clear enters from below and an
asynchronous preset from above. A register is named after the net it drives and sits
after the logic computing its input, so feedback is the one wire that runs back.
A bus stays one wire: a pin that reads part of it shows the slice on its lead, a
constant is written on the pin it ties, and a concatenation is gathered on a join bar.
Expanded bus bits follow their declared range. Small square terminals identify selectable
pins; round dots mark actual electrical branches. Clicking a wire highlights its visible
net/slice, while a pin selects its exact endpoint and gives connected wires a lighter highlight.
Pin and Wire tooltips identify the target. Gate pins retain separate identities even when
SDF delays make connected endpoints differ.

Use **Display** for light/dark themes, **Show compiler nodes**, **Full clock/reset wiring**,
**Show physical-only cells**, and grid. Light and no grid are the defaults. Clock/reset
connectors use exact connectivity and known pin roles, never matching names. Physical-only
cells are hidden only when their library interfaces are recognized; the toolbar reports
how many. Mapped and post-layout cells are drawn from the function their Liberty library
states: gates with bubbles on inverted inputs, AND-OR and OR-AND cells with their inner
gates, multiplexers, and flip-flops with the clock, enable and reset pins the library
describes. Rebuild a mapped or post-layout snapshot made by an earlier version to get
these symbols. Unknown cells retain explicit ports and labeled boxes. These preferences do not
change compilation or simulation. Selection/theme/cursor changes reuse layout. The grid
follows pan and zoom, uses coarser spacing at low zoom, and is excluded from export.

**Fit**, zoom buttons, mouse-wheel zoom and background dragging control the camera. Buses
stay bundled unless expanded; partial connections show taps/joins and constants stay near
consumers. **Export SVG** exports the current logical/detail view with its theme and labels,
without selection overlays. The desktop opens a native Save dialog; the browser downloads
the SVG. Try `examples/08_alu/hdlview.project.json` for arithmetic and logic, or
`examples/16_mem/hdlview.project.json` for memory. The internal schematic gallery
fixture is `tests/fixtures/schematic/hdlview.project.json`. Older artifacts remain readable;
source details missing from old snapshots require an explicit rebuild.

HDLView generates waveform instrumentation without editing the testbench. If a testbench
uses its own `$dumpfile`, HDLView accepts the sole VCD/FST in that new run directory with
the configured DUT scope when `trace.vcd` is absent. Multiple matching traces require an
explicit choice through Import waveform; malformed or wrong-scope outputs remain errors.
The actual selected path and hash are recorded in the run manifest.

## Live editor diagnostics

Working Verilog/SystemVerilog files are checked after 750 ms without typing, using
pyslang 10.0.0 for project correctness and Verible for style. Unsaved buffers,
including open headers, are analyzed in temporary copies. Typing and linting do
not change originals, create snapshots, or mark the schematic for rebuilding.
Checks pause during other jobs. Captured snapshot and auxiliary tabs are excluded.

Errors and warnings appear as underlines, gutter markers, and hover messages with
the engine and diagnostic code. Open **Problems** beside **Logs** for the full list;
click an entry to select its working-source range. F8/Shift+F8 navigate diagnostics
in the active editor. Linting does not open the panel or move the cursor.

Design analysis uses working project settings. Simulation files use the selected
owning configuration or their unique owner; **Lint simulation configuration**
resolves multiple owners. Missing tops/configurations and unreferenced headers
show **Limited analysis**. Generated gate netlists, cell models, and SDF are not
part of this working-source check. Icarus uses SystemVerilog-2012 while Slang 10
supports SystemVerilog-2017/2023; this difference is reported as limited analysis,
and actual simulator compilation remains authoritative.

**Project Settings → Editor** has **Live linting** and **Style checks** toggles. Changes take effect on Apply or OK. They are
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
cargo run -p hdlview -- --profile tools/profiles/docker.json build examples/04_adder_N/hdlview.project.json --representation elaborated
# The JSON result includes directory and id.
target/debug/hdlview simulate /absolute/artifact/directory/snapshot.json --configuration rtl
target/debug/hdlview view /absolute/artifact/directory/snapshot.json --scope adder_N
target/debug/hdlview wave /absolute/path/trace.vcd
```

Representations: `source`, `elaborated`, `generic`, `mapped`, `post_layout`.

The counter regression fixture includes physical constraints and an SDF configuration
for the following timing workflow. The public exercises need physical settings configured first.

```sh
target/debug/hdlview --profile tools/profiles/docker.json build tests/fixtures/counter/hdlview.project.json --representation post_layout
target/debug/hdlview simulate /absolute/artifact/directory/snapshot.json --configuration timing
```

`--store` selects the artifact root; the CLI defaults to `.hdlview`. Desktop artifacts use the OS application cache directory. `resume-physical DIRECTORY` retries collection of final physical artifacts when compilation/import failed before a snapshot was published. Existing snapshots are never overwritten by this command.

Use **named port connections in gate testbenches**: physical tools may reorder declarations. Use one ordinary simulation configuration for RTL or gates; the selected snapshot chooses the DUT implementation. Test public interfaces: RTL-internal probes or DUT parameter overrides may need adjustments after synthesis. Configurations with SDF remain gate-only and require Icarus. `timing_corner` selects the exported SDF file, while `delay_selection` independently chooses `min`, `typ`, or `max`. OpenSTA's exported sparse triples use `max` by default; a missing selected value is an annotation error, not an assumed zero delay.

`hdlview rpc` is a local JSON-lines interface used by tests, sharing the same application service as Tauri. It is not a network service. See [architecture](docs/ARCHITECTURE.md).

## Verification and packaging

The original SVG glyph gallery is available at `/?symbol-gallery` on the frontend dev
server. Its light/dark Playwright baselines are reviewed images in
`tests/symbol-gallery.spec.ts-snapshots/`; review geometry changes before refreshing them.
`tools/qualify.py --schematics` adds captured-behavior/symbol/connectivity checks and the
mixed schematic fixture to the real tool matrix; add `--mapped` for both PDK libraries.
`node tools/benchmark-layout.mjs` measures mixed and high-fan-out graphs in the actual
browser worker after a production build. No reference SVG skins or font assets are bundled.

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
