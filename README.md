# HDLView

Linux desktop HDL schematic and waveform explorer, with a Rust core and headless CLI.

- Source/dataflow, elaborated RTL, generic gates, PDK-mapped gates, and post-layout views.
- Verilog/SystemVerilog and VHDL projects, using existing open-source compilers.
- Bidirectional schematic/waveform selection, instance-aware signal identities, bus expansion, and exact integer timestamps.
- Icarus, Verilator, and GHDL simulation; VCD/FST/GHW import through Wellen.
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

The tools are separate from the desktop application. Build the qualified derived image:

```sh
docker build -f tools/Dockerfile -t hdlview-tools:2025.12 .
```

The base image alone supports many compilation tasks, but **does not provide the complete source-VHDL/physical toolchain**. The derived image pins matching GHDL Python bindings, LibreLane 3, and Magic. Its LibreLane profile intentionally bypasses the base image's legacy LibreLane 2 wrapper to use the matching newer OpenROAD and OpenSTA binaries.

Open `examples/counter/hdlview.project.json`, `examples/verilog/hdlview.project.json`, or `examples/vhdl/hdlview.project.json`. The default desktop profile matches [tools/profiles/docker.json](tools/profiles/docker.json). Select a representation, build, then run a simulation. The VHDL example uses `rtl` for GHDL and `gates`/`timing` for Verilog netlist simulation.

For a native installation, adapt [native.example.json](tools/profiles/native.example.json) in the Toolchain editor. Set plugin paths and relevant environment variables as well as executables. The Python environment must contain compatible `pyslang` and, for source VHDL, compiler-matched `pyGHDL`. Standard-cell interface extraction also uses `pyslang`.

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

Use **named port connections in gate testbenches**: physical tools may reorder declarations. For a VHDL-origin netlist, supply a Verilog/SystemVerilog gate testbench. `timing_corner` selects the exported SDF file, while `delay_selection` independently chooses `min`, `typ`, or `max`. OpenSTA's exported sparse triples use `max` by default; a missing selected value is an annotation error, not an assumed zero delay.

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

The browser test compiles a real hierarchical design and simulates it through the CLI service. `tools/qualify.py` runs a repeatable toolchain matrix; `tools/benchmark.py --mib 1024` measures large-VCD parsing. `node tools/benchmark-layout.mjs` and `python3 tools/benchmark-values.py` measure browser layout and cached cursor queries.

With host desktop development libraries, `npm run package` invokes Tauri packaging. An isolated Ubuntu 22.04-compatible Debian package can instead be built with:

```sh
bash tools/package-linux.sh
# target/packages/hdlview_0.1.0_amd64.deb
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
