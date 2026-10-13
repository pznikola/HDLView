# HDLView

Desktop HDL schematic and waveform explorer for Linux and Windows, with a Rust core and headless CLI.

- Elaborated RTL, PDK-mapped gate, and post-layout views with hardware symbols.
- Verilog/SystemVerilog projects, using existing open-source compilers.
- File-menu project creation/opening, grouped RTL/simulation imports, editable source tabs, and automatic project artifact restoration.
- Live syntax, semantic, and style diagnostics for unsaved design and simulation buffers.
- Bidirectional schematic/waveform selection, instance-aware signal identities, bus expansion, and exact integer timestamps.
- Icarus and Verilator simulation; VCD/FST import through Wellen.
- SKY130 and IHP LibreLane flow integration, reports, final netlists, and SDF delay simulation.
- Native executable profiles or Docker, immutable inputs, command manifests, logs, cancellation, and session restoration.

**A waveform belongs to exactly one snapshot and representation.** Closing a waveform session permits stage changes. Imported traces require an explicit DUT scope; file formats alone cannot prove which sources produced them.

This is version 0.1.0. Read [qualification and remaining limitations](docs/QUALIFICATION.md) before interpreting timing or physical results. Icarus does not provide complete timing-check coverage. A successful simulation does not imply clean DRC, LVS, or STA.

## Install

HDLView is installed in three steps. The desktop application and the HDL tools are
separate downloads.

1. Install Docker: [Docker Engine](https://docs.docker.com/engine/install/) on Linux,
   [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/)
   with the WSL 2 backend on Windows. On Linux, allow your user to run it, then log
   out and in:

   ```sh
   sudo usermod -aG docker $USER
   ```

2. Download the tools image (about 4 GB; it needs about 20 GB of free disk space):

   ```sh
   docker pull hpretl/iic-osic-tools:2026.09
   ```

3. Download HDLView from the
   [Releases page](https://github.com/pznikola/HDLView/releases). On Ubuntu 22.04 or
   later install the `.deb` package:

   ```sh
   sudo apt install ./hdlview_0.1.0_amd64.deb
   ```

   On Windows 10 or 11 run the setup `.exe`. It installs for the current user and
   needs no administrator rights. The installer is not signed, so Windows asks for
   confirmation the first time.

Start **HDLView** from the application menu. The package installs the bundled
examples read-only under `/usr/share/hdlview/examples`; copy them to your home
directory before opening one:

```sh
cp -r /usr/share/hdlview/examples ~/hdlview-examples
```

The image is the unmodified [IIC-OSIC-TOOLS](https://github.com/iic-jku/IIC-OSIC-TOOLS)
release; HDLView neither changes nor distributes it. Each HDLView version is qualified with one release of that image, named in the
default profile. Releases before 2026.08 lack LibreLane 3 and are rejected. Newer
releases may work; **Check toolchain** lists the tool versions found. When Docker is
not installed, not running, or the image is absent, the start panel and the footer
say which step is missing and show the command for it.

On Windows only the Docker toolchain is supported, with the PDKs inside the image.
The Windows build compiles and its path handling is qualified on Linux, but it has
**not yet been run on a Windows machine**; see the
[qualification notes](docs/QUALIFICATION.md#windows-port).

## Development

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

Open `examples/00_mux/hdlview.project.json` for a small first design, or
`examples/04_adder_N/hdlview.project.json` for a hierarchical adder. All 18
[SystemVerilog examples](examples/README.md) have ready-to-run project and simulation
settings. The default desktop profile matches [tools/profiles/docker.json](tools/profiles/docker.json).
Select a representation, build, then run the **rtl** simulation configuration.

Use **File → Create New Project…** to choose a name, directory, and **SKY130** or **IHP SG13G2** technology. Add files, folders, or `.f`/`.flist` inputs, review them, then finish with **Create New Project**. Files stay in their original locations; cancelling the wizard writes no configuration. Empty projects can be created. Set the top in **Project Settings** before building; mapped/physical builds also require a clock port and period.

**File → Add New Files…** adds Verilog/SystemVerilog inputs to **Design Sources** or **Simulation Sources**. Both RTL and gate runs use the same registered testbench files; gate runs compile the exact exported Verilog netlist. Headers remain separate from compilation units. The Sources explorer preserves directories under each group; right-click an imported folder/filelist (or use Shift+F10) to rescan/reimport. Configure the testbench in **Project Settings → Simulation**; registering a simulation file does not invent a configuration.

**Project Settings** groups controls into **General**, **Sources**, **Simulation**, **Physical Design**, and **Editor**. General sets the design top, language standard, and technology. Sources controls compilation order, includes, defines, and design parameters. Physical Design sets the clock period, the clock port, SDC, utilization and density; the standard-cell preset follows technology. The period is always required. Leave the clock port empty for a design without a clock: synthesis and timing then use a virtual clock of that period, so the period is the delay budget from inputs to outputs, and clock-tree synthesis is skipped. List further clock ports under **Additional clock**, each with its own period. Clocks are asynchronous to each other unless **Clocks are related** is ticked, so paths from one clock to another are not timed; synthesis targets the shortest period. A custom SDC file replaces these generated constraints. **Keep module hierarchy at Mapped gates** is on by default: each module is synthesized on its own and drawn on its own sheet, opened by double-clicking its instance, so a large design is a few small sheets instead of one. Untick it for one flat netlist optimized across module boundaries. Post-layout is always flat, because place and route inserts clock and repair buffers across modules. A design of only a few cells would get a core too small for the power grid, so a Post-layout build first synthesizes, and lowers the core utilization when needed; the build's diagnostics say so. Setting `FP_SIZING`, `DIE_AREA` or `CORE_AREA` in the LibreLane overrides turns that off. IHP SG13G2 builds are checked with IHP's KLayout DRC deck only: Magic's rules for that PDK reject the library's own tie-high cell. Add `"RUN_MAGIC_DRC": true` to the overrides to run Magic DRC as well. Gate-level simulation uses Icarus only: Verilator updates standard-cell flip-flops at once, so a value crosses several flops in one clock edge. Verilator configurations are for Elaborated RTL; on a Mapped gates or Post-layout schematic they are greyed out in the configuration list. For RTL runs under Verilator the testbench must itself give the DUT the project's parameter values; HDLView checks this at time zero because Verilator does not accept an override from outside the testbench.

For the counter example, choose **Simulation → Add Simulation Configuration**, leave **Icarus** selected, enter **Testbench top module** `tb` and **DUT instance path** `tb.dut`, and select `tb.sv`. The path begins with the testbench top and names its counter instance. Simulation duration defaults to 1 µs. **Add Simulation Sources…** imports files without discarding settings edits. Named configurations can be duplicated, renamed or deleted; Advanced exposes simulation defines, literal runtime arguments, gate models and SDF choices. SDF requires Icarus and a matching gate snapshot.

**Apply** updates the working project and leaves the dialog open; **OK** applies and closes. **Cancel**, Escape and the close button discard changes since the last successful Apply. Use **File → Save Project** to persist applied settings. Apply does not build, simulate, or save source buffers. After changing captured settings, rebuild the schematic before running simulation; the existing waveform remains bound to its original snapshot. Missing setup has a **Configure** shortcut, including the linter's missing simulation context.

The Sources explorer shows registered entries with file/folder icons, selection, active-file highlighting, and dirty/missing indicators. Use **File → New File…** (`Ctrl+N`) or the New File/New Folder heading icons. Design files default to `rtl/`, simulation files to `sim/`; folder context actions use that folder, and the directory picker can select an external destination. New `.v`/`.sv`/`.vh`/`.svh` files are empty and open in the editor. Headers register an include directory. New folders remain visible after Save Project/reopen without automatically importing their contents. No top or simulation configuration is inferred.

Right-click an entry (or press `Shift+F10`) for **Rename**, **Remove from Project**, and **Move to Trash**. Arrow keys navigate the tree, Enter opens a file, and `F2` renames it. Renaming preserves open buffers and history, and updates project references; HDL include strings and filelist contents require manual correction. Removing membership leaves originals on disk and records persistent import exclusions; explicitly selecting an excluded entry in a later import review re-adds it. Moving to Trash uses the original host file even with a Docker toolchain. Folder Trash is blocked by unregistered files, including hidden entries. Project/root headings and internal artifacts cannot be renamed or trashed.

Disk creation, rename, and Trash happen immediately; **Save Project** persists the updated membership. **Discard does not undo those disk operations.** Modified tabs offer Save/Discard/Cancel before removal or Trash. Linux Trash requires `/usr/bin/gio` from `libglib2.0-bin`; install that package for native/AppImage use. The Debian package declares it. Trash failures do not fall back to permanent deletion. Restoring from desktop Trash is handled by your file manager, followed by an explicit re-add if needed.

**File → Save Project** saves edited documents, project configuration, and current artifact references. `Ctrl+S` saves the active file; `Ctrl+Shift+S` saves the project. External edits offer Reload/Overwrite/Cancel. Closing a dirty tab/project/window offers Save/Discard/Cancel. Sources must be saved before building. Saved edits mark the schematic **Rebuild required**; captured source navigation remains read-only with a separate working-file action. UTF-8 BOM and LF/CRLF are preserved; unsupported encodings, mixed line endings, and CR-only files are reported.

Use **Sources**, **Design**, and **Inspector** to choose the left sidebar view. Selecting a schematic object updates its inspection details without switching the sidebar. The editor and schematic share the area beside it and can be hidden independently.

**Waveforms**, **Logs**, and **Problems** share a panel across the full window width. Choose a tab to open it, or use its collapse button to give the upper panes more space. A successful simulation opens Waveforms. Switching tabs preserves waveform rows, cursor, zoom and radix; each view scrolls independently. Drag the sidebar, editor, or bottom-panel dividers to resize them. Focus a divider and use arrow keys, or Home/End for its limits. The sidebar stays between 224 and 420 pixels, leaving at least 360 pixels beside it on supported window sizes. The bottom panel defaults to 35%, with a 140-pixel minimum and limits that leave at least 260 pixels above it. The editor/schematic split stays within 20–80%, reserving 200/320 pixels respectively when space permits. Pane sizes start with defaults when reopening a project.

**File → Open Existing Project…** selects JSON using the native picker and automatically reopens that project's last valid schematic and matching waveform. There is no separate Restore Session command. Restoration is local to this machine and the configuration's canonical path; tabs, pane sizes, scope and row selection start with defaults; the waveform trace list and view are kept (see Waveforms below). Missing/corrupted artifacts produce warnings; changed working inputs retain the old immutable schematic with a rebuild indication. Opening never compiles or simulates automatically. **Close Project** leaves sources and artifacts on disk.

Registered external roots appear as `@root/path`; include settings accept project-relative paths or that notation. Folder rescans preserve manual compilation order; filelist reimports apply reviewed order and retain source/header roles. Project files use schema 3 only; a file of another schema version or with unknown fields is rejected, and opening it leaves the current workspace intact. Schematics and waveforms built by an earlier HDLView version are not read: the project opens without a schematic until the design is built again.

For a native installation, adapt [native.example.json](tools/profiles/native.example.json) in the Toolchain editor. Set plugin paths and relevant environment variables as well as executables. The Python environment must contain pyslang 10 or 11, which live editor diagnostics and standard-cell interface extraction use. A Docker profile must name its image.

## Schematic workspace

The schematic uses gate, mux, register, arithmetic, memory and directional-port symbols.
Open a module with its expansion button or double-click it; **Back to parent schematic**
restores the previous camera. The stages are **Elaborated RTL**, **Mapped gates** and
**Post-layout**; the two gate stages need physical settings and the PDK toolchain.
Delays in the design, such as `assign #5 y = a;`, are not drawn: the schematic shows the
logic alone, and an RTL simulation compiles the sources and keeps the delays. A source
that sets no time unit is simulated with 1 ns units and 1 ps precision.

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
how many. When shown, they fill rows below the logic, because they connect to nothing but
the supplies. Mapped and post-layout cells are drawn from the function their Liberty library
states: gates with bubbles on inverted inputs, AND-OR and OR-AND cells with their inner
gates, multiplexers, and flip-flops with the clock, enable and reset pins the library
describes. Unknown cells retain explicit ports and labeled boxes. These preferences do not
change compilation or simulation. Selection/theme/cursor changes reuse layout. The grid
follows pan and zoom, uses coarser spacing at low zoom, and is excluded from export.

**Fit**, zoom buttons, mouse-wheel zoom and background dragging control the camera. A
sheet of more than 400 objects is drawn only around the window, and as plain cell and
wire outlines when zoomed far out; click a cell in the outline to inspect it, and zoom in
for pins and names. Such a sheet also gets a minimap in the lower right corner: the
rectangle is the window, the dot is the selection, and a click or drag moves the window
there (**Display → Show minimap on large sheets** turns it off). **Show selection** brings
the selected wire or inspected cell into the window; picking a signal in the signal list
or a trace in the waveform does that by itself when the object is out of sight. One sheet shows at most 5,000 cells with signal pins; the toolbar
says how many are outside the view. A flat netlist whose memory became flip-flops gives a
very tall sheet, one row per flip-flop: HDLView draws it quickly but does not compact
it. Buses
stay bundled unless expanded; partial connections show taps/joins and constants stay near
consumers. **Export SVG** exports the current logical/detail view with its theme and labels,
without selection overlays. The desktop opens a native Save dialog; the browser downloads
the SVG. Try `examples/08_alu/hdlview.project.json` for arithmetic and logic, or
`examples/16_mem/hdlview.project.json` for memory. The internal schematic gallery
fixture is `tests/fixtures/schematic/hdlview.project.json`.

### Waveforms

The trace list is yours to arrange and is kept on this machine for each project, stage and
testbench: a new simulation run or reopening the project shows the same rows in the same
order, with their radix, colour, expanded buses and dividers, and the same window, cursors,
time unit and name-column width. A saved row whose signal is not in the new trace
stays in the list, greyed. Only a project with no saved list starts with the first twelve
signals of the DUT.

- **Moving in time.** Ctrl+wheel (or pinch) zooms around the pointer, Shift+wheel or a
  sideways scroll pans, a middle-button drag pans, and dragging with the left button zooms
  to the dragged range. The plain wheel scrolls the rows. **Zoom in**, **Zoom out** and
  **Full trace** remain. The ruler above the traces shows round times in the chosen
  **Time unit** (automatic by default, or s to fs, or raw ticks).
- **Cursors.** A click sets the cursor and lands on a change of the clicked row when one
  is within a few pixels; a click on the ruler sets it exactly. Shift+click sets a second
  cursor **B**, and **Set B** (key `B`) puts B where A is so that you can then move A
  and measure from there. Press on the ruler and drag to slide A along it; drag B by its
  flag, or with Shift. The toolbar always shows the times of A and B, their difference
  and the matching frequency. **Previous edge** and **Next edge** (and the Left/Right keys) move the cursor that was
  moved or chosen last, A or B (click its time in the toolbar to choose it; it is the
  outlined one), to the nearest change of
  the selected row (of the clicked bit for an expanded bus) and bring it into the window.
- **Values.** Each row shows its value at the cursor beside its name. The toolbar
  **Radix** (hex, binary, octal, unsigned, signed, ASCII, float for 32 and 64 bit values)
  applies to every row without its own; right-click a row to give it its own radix or
  colour. A pixel that holds several changes is drawn as a filled bar.
- **Rows.** Drag a name to reorder; right-click for **Add divider above** and **Remove**;
  double-click a divider to rename it. Drag the edge of the name column to widen it, or
  clear **Full paths** to show only the last part of each name.
- **Keys** (with the waveform focused): Left/Right previous/next edge, Shift+Left/Right
  pan, Up/Down select a row, Alt+Up/Down move it, `+`/`-` zoom, `F` full trace, `B` put
  cursor B on A, Delete remove the row.

HDLView generates waveform instrumentation without editing the testbench. If a testbench
uses its own `$dumpfile`, HDLView accepts the sole VCD/FST in that new run directory with
the configured DUT scope when `trace.vcd` is absent. Multiple matching traces require an
explicit choice through Import waveform; malformed or wrong-scope outputs remain errors.
The actual selected path and hash are recorded in the run manifest.

### Floorplan and layout

**Floorplan & Layout** in the bar above the editor replaces the editor and schematic with the floorplan and layout view; **Code & Schematic** brings them back.

- **Floorplan.** Without a floorplan the flow sizes the block from the core utilization; after a Mapped gates or Post-layout build the view draws that square and **Use as fixed floorplan** keeps it. **Draw floorplan** drags out a rectangle; its right and top edges and its corner resize it, and **Width µm** / **Height µm** set it exactly. **Automatic** removes it. Project Settings → Physical Design has the same size under **Fixed floorplan size**.
- **Pins.** The port list beside the canvas gives each port a side, or drag a port onto a side; drag a placed pin along or between sides to reorder it, or well away from the outline to release it. A vector port stays together. Pins have a side and an order, not coordinates: the flow spreads them along the side on legal tracks. As soon as one port has a side, every port without one goes to the side with the fewest pins, so the result does not change between runs.
- **Does it fit.** With the cell area known, the bar shows how much of the rectangle the cells fill. A Post-layout build synthesizes first and stops with "The design cannot fit in W × H µm" when the cells are larger than the rectangle or a side is shorter than one set of power straps. When place and route itself stops, the error names the step and quotes the tool's message; power grid, pin, placement and routing errors are reported as a design that cannot fit.
- **Layout.** After a Post-layout build the view shows the final GDS. HDLView reads the GDS itself (`crates/hdlview-core/src/gds.rs`: boxes, polygons, paths as their hulls, placements, arrays, labels) and the PDK's KLayout layer file (`layer_properties.rs`), so every mask layer appears with the layer file's names, colours and fill patterns, with KLayout's built-in patterns, custom patterns numbered by their position in the file, its row offset per layer, and its palette for layers the file does not list; layers the file hides or marks invalid start hidden. The layer file's line styles, frame widths, brightness, transparency and group inheritance are not reproduced. The masks are drawn with antialiased WebGL2. A worker prepares indexed geometry and spatial bounds once; pan and zoom cull off-screen placements and routing batches, reuse GPU buffers, and preserve the actual polygons at every zoom. Camera-relative high/low coordinates keep large-coordinate edges aligned. The depth buffer preserves layer order, and PDK patterns stay anchored to device pixels. Masks and overlays share one camera and animation frame, including at fractional display scaling. The active snapshot's layout stays loaded when switching panes. Labels, the die and core outlines, the selected signal's wires (white), the selected cell and DRC markers are drawn over the masks. The layer list has a checkbox per layer, **Show all**, **Hide all** and **Routing only**, which keeps the purposes of the technology's metal and via layers. Clicking a cell opens it in the Inspector and clicking a wire selects its signal, highlighting only that wire's net rather than the whole vector; clicking the same wire again clears the highlight, and a signal chosen elsewhere highlights all of its bits. These names come from the flow's own database, which a GDS does not carry. A GDS with a magnified or non-quarter-turn placement is reported as an error rather than drawn wrong. KLayout's rulers, menus and editing are not part of the view.
- **3D view.** The **3D** tab extrudes the same GDS with the PDK's KLayout 2.5D script (`libs.tech/klayout/**/*.lyd25`, copied beside the run), which HDLView reads itself (`layer_stack.rs`): layer inputs, variables, `|`, `&` and `-` with Ruby's precedence, `z` and `zz` with `zstart`, `zstop`, `height`, `name`, `color`/`fill` and `like`, and `.nm`/`.um` heights; a script using anything else is reported and the tab says the 3D view is unavailable rather than drawing a wrong stack. Booleans such as sky130's contact over poly or IHP's contact to gate poly are evaluated with the `i_overlay` crate within each cell and within the top cell, never across the hierarchy. The tab opens on the area the Layout tab shows (whole design when the Layout view is at fit or the Floorplan tab is active), with the top cell's shapes cut at that area's edges and the cells placed in it kept whole, and **Whole design** / **Region of the Layout view** rebuild it; the toolbar shows the area in µm and the scene's triangle count. Each cell's slabs are one instanced mesh, the top cell's shapes are batched around their own origins, and only placements and batches under the view's footprint are drawn; faces turned away from the viewer are skipped, and a placed cell far enough away that its walls would cover under two pixels is drawn as its top faces only (wires always keep their walls). When frames come late while the view moves, it is drawn at half resolution until it rests. Left-drag turns, right-drag or Shift-drag pans, the wheel moves closer, **Fit** and **Top** reset the view and **Z scale** stretches heights. The **Materials** list (top first) has a checkbox per material with **Show all** / **Hide all**; materials of layers hidden in the Layout tab start hidden. The selected signal's wires and the selected cell (as a lid over the stack) are drawn white. Not drawn: labels, shape edges, line styles, transparency, cross sections; nothing can be picked in 3D, and GF180 ships no 2.5D script.
- **Checks.** Routing DRC, Magic DRC, KLayout DRC, XOR, LVS and Antenna each read clean, a count, or not run. A DRC row lists its rules; a violation's coordinates zoom to it. LVS shows the device and net counts of layout and netlist and the nets, devices and pins that differ.

The names and checks need `openroad` and `python3` on the toolchain's PATH, and the mask view needs the PDK's layer file (`libs.tech/klayout/tech/*.lyp`) and the 3D view its 2.5D script (`*.lyd25`), which the build copies beside the run; a build without them is still complete and says which view is missing. The view itself needs a window with WebGL2. `physical.floorplan` in the project file holds `width_um`, `height_um` and `pins` (`port`, `side`); it cannot be combined with `FP_SIZING`, `DIE_AREA`, `CORE_AREA`, `IO_PIN_ORDER_CFG` or `FP_DEF_TEMPLATE` in the LibreLane overrides.

## Live editor diagnostics

Working Verilog/SystemVerilog files are checked after 750 ms without typing, using
pyslang for project correctness and Verible for style. Unsaved buffers,
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

The qualified Docker image includes Verible `v0.0-4294-gc1d8f5e8`. Native users set
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
version mismatch, select `hpretl/iic-osic-tools:2026.09` in Toolchain. Native users
install pyslang 10 or 11 into the Python environment selected by their profile.

## Headless workflows

```sh
cargo run -p hdlview -- --profile tools/profiles/docker.json build examples/04_adder_N/hdlview.project.json --representation elaborated
# The JSON result includes directory and id.
target/debug/hdlview simulate /absolute/artifact/directory/snapshot.json --configuration rtl
target/debug/hdlview view /absolute/artifact/directory/snapshot.json --scope adder_N
target/debug/hdlview wave /absolute/path/trace.vcd
```

Representations: `elaborated`, `mapped`, `post_layout`. `--profile` selects the toolchain; without it the native tools on `PATH` are used.

The counter regression fixture includes physical constraints and an SDF configuration
for the following timing workflow. The public exercises need physical settings configured first.

```sh
target/debug/hdlview --profile tools/profiles/docker.json build tests/fixtures/counter/hdlview.project.json --representation post_layout
target/debug/hdlview simulate /absolute/artifact/directory/snapshot.json --configuration timing
```

`--store` selects the artifact root; the CLI defaults to `.hdlview`. Desktop artifacts use the OS application cache directory. `resume-physical DIRECTORY` retries collection of final physical artifacts when compilation/import failed before a snapshot was published. Existing snapshots are never overwritten by this command.

Use **named port connections in gate testbenches**: physical tools may reorder declarations. Use one ordinary simulation configuration for RTL or gates; the selected snapshot chooses the DUT implementation. Test public interfaces: RTL-internal probes may need adjustments after synthesis. A testbench may keep setting DUT parameters: the simulated copy of the netlist declares the values the design was built with, and a testbench that sets a different value fails at elaboration instead of simulating the wrong design. Type parameters and array-valued parameters cannot be set on a netlist. Design sources that declare only packages are compiled for gate simulations too, so a testbench may import them; a package that shares its file with a module is not, and belongs in a file of its own. SKY130 gate runs without SDF define `UNIT_DELAY=#0.01`, a 10 ps clock-to-Q delay in the functional cell models that keeps flip-flops behind different clock-tree depths in order; set `UNIT_DELAY` in the configuration's defines to change it (`#1` is the Caravel convention). Configurations with SDF remain gate-only and require Icarus. `timing_corner` selects the exported SDF file, while `delay_selection` independently chooses `min`, `typ`, or `max`. OpenSTA's exported sparse triples use `max` by default; a missing selected value is an annotation error, not an assumed zero delay.

`hdlview rpc` is a local JSON-lines interface used by tests, sharing the same application service as Tauri. It is not a network service. See [architecture](docs/ARCHITECTURE.md).

## Verification and packaging

The original SVG glyph gallery is available at `/?symbol-gallery` on the frontend dev
server. Its light/dark Playwright baselines are reviewed images in
`tests/symbol-gallery.spec.ts-snapshots/`; review geometry changes before refreshing them.
`tools/qualify.py --schematics` adds symbol/connectivity checks, the mixed schematic
fixture and every bundled example to the real tool matrix; add `--mapped` for both PDK libraries.
`node tools/benchmark-layout.mjs` measures mixed, high-fan-out and memory-shaped graphs
in the actual browser worker after a production build. No reference SVG skins or font assets are bundled.

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

The browser test compiles a real hierarchical design and simulates it through the CLI service. `tools/qualify.py` runs a repeatable shared-testbench matrix; `--mapped` adds both PDKs, `--physical` adds full flows, and `--store` keeps provider reports separate; `tools/benchmark.py --mib 1024` measures large-VCD parsing. `node tools/benchmark-layout.mjs` and `python3 tools/benchmark-values.py` measure browser layout and cached cursor queries. The separate physical-viewer benchmark is `node tools/benchmark-masks.mjs /path/to/layout_masks.json --headed` (omit `--headed` to measure the browser's headless renderer). It reports worker preparation, first GPU-complete frame, warm CPU/GPU and frame-interval percentiles, submitted index references, and buffer upload bytes in `.hdlview/benchmarks/masks-result.json`; always check the reported renderer before comparing hardware with software. `QT_QPA_PLATFORM=offscreen klayout -b -r tools/check-mask-geometry.py -rd input_gds=design.gds -rd input_masks=layout_masks.json` compares placement coordinates/orientations and polygon coverage with KLayout.

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
