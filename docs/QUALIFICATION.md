# Qualification — 7 October 2026

This file records exercised workflows separately from proposed release targets. Version 0.1.0 is an engineering preview; it is not a claim of complete HDL-language coverage or signoff-quality timing simulation.

## Stock image qualification

Measured 13 October 2026. HDLView now runs the unmodified
`hpretl/iic-osic-tools:2026.09` image
(`sha256:b87b3f1af9ba72d9486466ea777cf4248e96e20d9dba76d67259bc185db3859c`) instead of
a derived image; `tools/Dockerfile` is removed. The image reports Yosys 0.69,
pyslang 11.0.0, Icarus 14.0 development build, Verilator 5.052, Verible
`v0.0-4294-gc1d8f5e8`, LibreLane 3.1.0.dev3, Magic 8.3.684 and OpenROAD
`26Q3-2443-g50432012f`.

Two changes were needed:

- pyslang 11 moved `Driver` and `SyntaxKind` into submodules. The three helper scripts
  accept both layouts, and the version check accepts pyslang 10 and 11.
- The image's IHP PDK keeps its sequential primitives in `sg13g2_udp.v`, which gate
  simulation now compiles before `sg13g2_stdcell.v`.

With the default Docker profile and no derived image in use:

| Check                                                    | Result                              |
| -------------------------------------------------------- | ----------------------------------- |
| `tools/qualify.py --schematics`                          | 86 records, none failing            |
| `tools/qualify.py --mapped`, SKY130 and IHP              | builds and gate simulations pass    |
| `tools/qualify.py --physical`, SKY130 and IHP            | both flows complete, 117 s and 95 s |
| Layout, mask layers, 3D stack and check results          | produced for both PDKs, no warnings |
| RTL and SDF timing simulation of the Post-layout netlist | pass on both PDKs                   |
| `tools/qualify-editor-lint.py`                           | all cases pass                      |
| `npm run test:e2e`                                       | 32 passed                           |

The 35 course projects of lectures 01 to 03 and exercises 01 and 02 build as Elaborated
RTL and their 46 simulations run. The browser suite passed in three of five full runs.
In the other two, the 3D test that expects half resolution after slow frames failed
(it depends on rendering speed and passes alone), and once the source-explorer rename
test failed; that failure was not reproduced alone or in two later full runs, and its
cause is not known.

The setup status was exercised from the CLI on this host: a profile naming
`hpretl/iic-osic-tools:2025.12` is reported as too old with the pull command for the
qualified release, an absent tag as not downloaded with its pull command, and an
unreachable daemon as not running. `probe` now also reports `vvp`, `openroad` and the
two PDK liberty files. Docker absent, stopped and image states of the setup panel are
covered by unit tests with a substitute `docker` and by four browser tests against a
mocked service; the panel was not exercised in the packaged desktop window.

`tools/package-linux.sh` built `hdlview_0.1.0_amd64.deb` (version taken from
`Cargo.toml`, 124 example files and both profiles under `/usr/share/hdlview`) and
`tools/smoke-package.py` passed on it. The package was not installed on a clean
system, and the GitHub workflows (`ci.yml`, `release.yml`) have not been run.

## Windows port

Prepared 13 October 2026 on the Linux host. **HDLView has not been run on Windows.**
What was checked here, and what was not:

- `cargo check -p hdlview-core -p hdlview --tests --target x86_64-pc-windows-gnu`
  passes. The host has no Windows linker or resource compiler, so no Windows test was
  run and the desktop crate was not checked for Windows.
- On Windows a Docker tool sees the workspace at `/hdlview/work`, because a Linux
  container cannot mount `C:\…` at the same path. Every path given to a tool and
  every path read back from one is translated. With that mapping forced on by
  `HDLVIEW_CONTAINER_PATHS=1` on Linux, `tools/qualify.py --schematics` (86 records),
  `--physical` on SKY130 and IHP (123 s and 101 s, layout, masks, 3D stack and checks
  produced), `tools/qualify-editor-lint.py` and `npm run test:e2e` (32 tests) pass.
  The mapping itself has unit tests for a Windows-style root.
- Written for Windows and compiled only: rename without replacement (`MoveFileExW`),
  the Recycle Bin (`trash` crate), child processes without a console window, canonical
  paths without the `\\?\` form, project file references stored with `/`, and
  parent-folder handling of `C:\…` paths in the interface.
- Not checked at all: the NSIS installer and the Windows jobs of the two workflows,
  Docker Desktop bind-mount speed, file ownership without `--user`, WebView2 rendering
  of the layout and 3D views, and cancelling a running build.
- The Windows CI job builds the installer and `tools/check-windows-installer.py`
  installs it silently, fails if it holds anything other than `HDLView.exe`,
  `uninstall.exe`, `LICENSE.txt` and `THIRD_PARTY_NOTICES.md`, and checks that the
  uninstaller removes it. The web interface and the Python helper scripts are compiled
  into `HDLView.exe`. The CLI probe must report a missing Docker or image there,
  because the runner cannot run Linux containers. This job has not run yet.

Qualification on a Windows 11 machine with Docker Desktop remains a release gate. On
this host that is a Windows 11 evaluation VM under KVM (nested virtualization is
enabled; CPU mode host-passthrough so WSL 2 runs inside it), with the installer from
the CI artifact, following the README as a student would:

- The setup panel with Docker Desktop absent, stopped, without the image, and ready.
- A course project: Elaborated, Mapped and Post-layout on SKY130 and IHP, Icarus and
  Verilator simulation, waveforms, layout and 3D views (software rendering in a VM),
  live lint, rename, delete to the Recycle Bin, and cancelling a running build.
- Post-layout time of `01_simpleRegister` and `17_afifo`.
- After uninstalling, the program folder and the Start menu shortcut are gone.

## Large gate schematics

Measured 9 October 2026 on the saved Post-layout snapshot of `examples/17_afifo`
(SKY130): one flat module of 16,330 cells, of which 13,968 are fill, tap and decoupling
cells and 2,362 have signal pins. Chromium, Playwright, release CLI as the service.

| Case                                                | Before                      | After                       |
| --------------------------------------------------- | --------------------------- | --------------------------- |
| Cells with signal pins in the view, physical hidden | 2,000 (362 cut off)         | 2,362                       |
| Cells with signal pins in the view, physical shown  | 7 of the first 2,000        | 2,362                       |
| Service builds the view (release)                   | not measured                | 0.3 to 0.5 s                |
| Layout of the sheet, 2,380 nodes, in the worker     | over 150 s, stopped         | 3.4 s                       |
| Elements in the page at Fit                         | every cell and wire         | 5                           |
| Elements in the page zoomed to full size            | every cell and wire         | 12,000 to 23,000            |
| Export SVG, physical hidden / shown                 | not measured                | 1.9 s / 3.7 s               |
| 1,000-node layout benchmark, first / repeated       | 1.6 to 1.9 s / 1.4 to 1.5 s | 0.7 to 0.8 s / 0.4 to 0.5 s |
| Memory-shaped benchmark, 2,500 / 5,000 nodes        | not measured                | 1.9 s / 3.5 s               |

- The "before" layout time was measured in Node with the same layout code and stopped
  after 150 s; the cause is the ELK request to keep the model order within layers, which
  large views no longer make. Fifteen other option sets changed the time by under 10 %.
- The sheet is about 9,600 by 64,000 px. Layer-width bounds, compaction, tighter spacing,
  component separation and high-fanout stubbing all left it between 54,000 and 82,000 px
  tall: 512 memory flip-flops feed one read multiplexer tree and each needs a row. Only
  bundling identical instances would shorten it; that is not implemented.
- The test bridge took 7 s to pass the 13 MB view to the page; that is Playwright, not
  the application. The same transfer through Tauri was **not measured**, nor was pan and
  zoom smoothness in the Tauri (WebKitGTK) window.
- Building the layout cache key (27 ms) and posting the graph to the worker (51 ms) were
  measured and left as they are.
- Checked in the browser: click on a cell at full size and in the outline, wire
  selection kept across Fit, export contains all 2,373 cells and 2,295 wires (16,341
  cells with physical shown). Cross-probing from a waveform on this sheet was not run.

### Module hierarchy at Mapped gates

9 October 2026, Docker image (LibreLane 3.0.0, Yosys 0.60), SKY130, release CLI.

| Design           | Flat (`flatten_mapped`) | Hierarchical (default)                                 |
| ---------------- | ----------------------- | ------------------------------------------------------ |
| `04_adder_N`     | not built               | 9 sheets: top with 8 instances, 5 cells per full adder |
| `17_afifo`       | 1 sheet, 1,516 nodes    | 6 sheets: top 16 nodes, pointers 60, `i_mem` 1,573     |
| `17_afifo` build | 12 s                    | 12 s                                                   |

- Icarus gate simulation of both hierarchical netlists completes with the unchanged
  `rtl` configuration. Waveform bindings inside the submodules are exact: 224 of 224 for
  the adder, 7,223 of 7,748 for the FIFO before the fix below.
- The 592 unbound FIFO signals were wires the netlist names bit by bit
  (`rd_address_w[0]`, `memory_m[9][7]`); the flat build had 594, two of them escaped
  names without an index. The trace reader joins such wires into one vector and keeps
  the backslash of an escaped name. Each wire now binds to its bit of that vector:
  **0 unbound** for `17_afifo` hierarchical (8,183 signals) and flat (7,317),
  `04_adder_N` (240), `11_fifo` (7,876) and `08_alu` (1,748). The signal list shows
  that one bit; the waveform row is the joined vector. Names with three or more
  trailing indices follow the same rule but no design here has one.
- Post-layout is unchanged and was not rebuilt. IHP SG13G2 and SDF timing runs were not
  tried with the hierarchical netlist (SDF belongs to Post-layout, which stays flat).
- Checked through the CLI and service, not in the desktop window.

### Navigation on a large sheet

Same snapshot and setup, 9 October 2026, after culling wires by segment and adding the
minimap and **Show selection**.

- Page elements for the same window at full size (40 cells, 232 wires): **12,031 before,
  2,416 after**. Other windows on the sheet measured 900 to 3,500.
- The minimap appears (48 by 240 px for this sheet); its window rectangle follows pan and
  zoom, and a click at 80 % of its height moved the window there.
- Picking `_0300_` in the signal list moved the camera to its wire at full size with the
  wire highlighted. A click on a cell in the schematic left the camera where it was.
  **Show selection** after panning away brought the object back inside the window.
- Export SVG still holds all 2,373 cells and 2,295 wires (10,300 segments).
- Not run: selection from a waveform trace on this sheet (same code path as the signal
  list, different origin), and anything in the Tauri window.

## Floorplan, layout view and checks

10 October 2026, counter fixture (353 µm² of cells on SKY130), Docker toolchain
`hdlview-tools:2025.12` for the flow, Chromium through the browser suite for the editor.

- **Fixed outline, SKY130.** 70 × 60 µm with `clk` on the left and `fast` on the right:
  the flow reported die `0 0 70 60`, `clk` on the west edge, `fast[0..3]` on the east
  edge in order, and the unplaced `enable`, `slow`, `reset` on the top and bottom. Build
  complete in about one minute; all six checks clean, LVS 55 devices and 56 nets on both
  sides.
- **Fixed outline, IHP SG13G2.** The same project: die `0 0 70 60`, build complete, Magic
  DRC listed as not run, KLayout DRC, XOR, LVS (78 devices, 79 nets) and antenna clean.
- **Too small, refused before place and route.** 12 × 12 µm: "The design cannot fit in
  12 × 12 µm: its cells need 353 µm² and the rectangle is 144 µm². At 30 % utilization it
  needs about 35 × 35 µm." after 7 s.
- **Too small for the power grid.** 32 × 30 µm and 40 × 36 µm passed the area check and
  stopped in the flow: "The design cannot fit in 40 × 36 µm: openroad-generatepdn failed."
  with PDN-0185 quoted.
- **Too dense.** 34 × 44 µm: "The design cannot fit in 34 × 44 µm:
  openroad-repairdesignpostgpl failed." with DPL-0036 quoted. The failure is recognised
  by the tool's error code; the step is not a placement step by name.
- **Unknown port.** A pin naming `count` stopped the build with "The floorplan places
  count, which is not a port of counter".
- **Layout view.** On the SKY130 result: die, core, pins, cells and the six metal layers
  drawn; zoomed in, cells show named pin shapes; a click on `clkbuf_1_0__f_clk` opened it
  in the Inspector. The dump of `17_afifo` (16,330 cells, about 44,000 wire boxes) took
  one second and is 2.4 MB.
- **Mask view from HDLView's own GDS reader.** 10 October 2026, Docker toolchain,
  Post-layout builds of `01_simpleRegister` on SKY130 and on IHP SG13G2 and of `17_afifo`
  on SKY130. The reader's result was compared with KLayout 0.28.8 reading the same GDS
  (a scratch script counting cells, placements per cell, shapes per layer and texts,
  with each placed cell flattened one level as the view does): identical on all three —
  the register on SKY130: 7 cells, 92 placements, 33 layers; on IHP: 7 cells, 89 placements,
  26 layers; `17_afifo`: 54 cells, 16,330 placements, 36 layers, 36,789 top-level shapes and 32 labels. Building the view took 4 ms for the register and
  about 20 ms for `17_afifo` (2.9 MB of JSON), against about two seconds for the
  KLayout export it replaces. Beside a headless KLayout render of the same layer file the
  pane shows the same colours, custom fill patterns and layer order on both PDKs; the
  differences are the ones documented in the README: the layer file's line styles (IHP's
  dashed `prBoundary` is drawn solid) and label colour (white, not the text layer's).
- **WebGL view.** Chromium on the NVIDIA GPU: the register's masks appeared 28 ms after the
  pane opened; 12 wheel zoom steps, 10 more, a 20-move pan and 6 zoom-out steps each
  completed within the two animation frames the measurement waits for (median 33 ms, which
  is that floor). `17_afifo`: every zoom and pan step also completed within that floor (median 33 ms, max
  34 ms, with all 36 layers shown and no culling beyond the window); its masks appeared
  6.1 s after the pane opened, almost all of it the test harness moving the 2.9 MB view
  through its line-based RPC (2.0 s per request, measured from the page) and the flow
  database (0.7 s) — the Rust side builds the view in 20 ms, and parsing it, triangulating
  the 54 cells and the top cell, packing the pattern atlas and one culling pass take under
  200 ms in Node. The Tauri IPC was not measured. Headless Chromium draws with software GL
  (SwiftShader): the register's steps then took 75 to 110 ms (max 190 ms). A click on a
  cell opened `_5_ · sky130_fd_sc_hd__dfrtp_2` and `_7_ · sg13g2_dfrbpq_1` in the
  Inspector; **Routing only** kept the same layers as before. The Tauri window on this
  machine (WebKitGTK 2.50) created a WebGL2 context and drew a test triangle.
- **3D view (11 October 2026).** The 2.5D script reader parsed both PDK scripts verbatim
  (`sky130.lyd25`: 18 inputs, the `licon` block, 16 materials in 17 slabs after dropping
  the unused `sub`/`dnw`; `sg13g2_beol.lyd25`: 22 materials with the resistor booleans). On
  fresh Docker Post-layout builds of `01_simpleRegister` (SKY130 and IHP) and `17_afifo`
  (SKY130, schema 6, no warnings) the boolean materials were compared with KLayout 0.28.8
  computing the same expressions on the same GDS (`pya.Region`, merged): SKY130 `licon`
  over poly 352 polygons / 10,172,800 dbu² and beside poly 1,054 / 30,460,600, identical;
  IHP `Cont->Gatpoly` 337 / 8,627,200 and `GatPoly` 326,753,125 dbu², identical areas.
  IHP `Cont->Activ` differs by exactly 600 contacts (ours 69,504,000 dbu², KLayout
  54,144,000): the GDS holds 3,252 raw contact shapes of which 2,452 remain after merging,
  and the 600 that coincide across neighbouring placements are merged by KLayout's
  flattened region but kept by the per-cell evaluation (documented; they draw as one).
  Materials shown as plain layers keep their raw shapes, so their summed areas exceed
  KLayout's merged areas where rails overlap. The 3D view request takes 54 to 84 ms on the
  registers and 744 ms for the whole `17_afifo` (2.9 MB, 16,330 placements of 54 cells,
  36,756 top shapes, 8.68 M triangles with every placement drawn) through the line RPC.
  Browser harness, headed Chromium on the NVIDIA GPU: after clicking **3D** the register
  views appeared in 1.2 to 1.3 s and the whole `17_afifo` in 7.0 s (of which the worker's
  extrusion takes 0.9 s in the benchmark and the first frame 216 ms; the rest is the
  harness moving the JSON); a 161 × 118 µm region of it (2.3 M triangles) in 2.5 s. Orbit
  and dolly steps driven through Playwright completed in a median of 50 ms, which is the
  harness's own floor. `tools/benchmark-solid.mjs` on the whole `17_afifo`: 8.68 M
  triangles per frame at fit, 16.7 ms frame interval (p50 and p95), 5.9 ms GPU p50 and
  13.5 ms p95, 4.6 ms CPU p50, 567 draw calls; a close oblique view culls to 1.47 M
  triangles (1.0 ms GPU); the top view 8.0 M (4.1 ms). The 100 µm region (1.23 M
  triangles) stays at 16.7 ms with under 2 ms of GPU time. No level of detail was needed.
  Headless Chromium's software GL (SwiftShader) is not practical for this view: the 100 µm
  region took 1.5 s per frame at fit and 0.5 s close up, and the whole `17_afifo` did not
  finish the benchmark's 195 frames within 15 minutes; the region mode keeps such a machine
  usable only for small areas.
  Screenshots of the register beside KLayout's own 2.5D window (`klayout -rr sky130.lyd25`)
  show the same stack order and the layer file's colours; the selected cell appeared as a
  white lid and **Region of the Layout view** produced a 25.9 × 19.0 µm view after
  zooming the Layout tab, with the top cell's wires and the highlight cut at its edges
  (unit tests cover a box and an L-shaped polygon crossing the edge). The region request on a stack with no shapes in it lists no
  materials. The 3D tab of the e2e fixture (`tests/workspace.spec.ts`) shows the two
  materials, draws frames on its own canvas, and returns to the Layout tab with its layers.
- **3D view speed (11 October 2026).** Measured with `tools/benchmark-solid.mjs --headed`
  (Chromium, ANGLE on the RTX 3060, 1100 × 700) on fresh Docker Post-layout builds, each
  design with the renderer of commit `431d28d` and with the optimized one; `--tile N` repeats
  a design N × N times. At fit, before → after:

  | Design                       | Triangles drawn | GPU p50 ms  | CPU p50 ms | Frame p50 ms | Preparation ms |
  | ---------------------------- | --------------- | ----------- | ---------- | ------------ | -------------- |
  | `01_simpleRegister`, SKY130  | 78 k → 78 k     | 0.10 → 0.06 | 0.2 → 0.2  | 16.7 → 16.7  | 30 → 17        |
  | `01_simpleRegister`, IHP     | 81 k → 81 k     | 0.10 → 0.07 | 0.2 → 0.2  | 16.7 → 16.7  | 62 → 16        |
  | `16_mem`                     | 8.26 M → 2.24 M | 4.4 → 1.2   | 1.4 → 0.5  | 16.7 → 16.7  | 394 → 250      |
  | `17_afifo`                   | 8.68 M → 2.30 M | 4.3 → 1.8   | 1.5 → 0.6  | 16.7 → 16.7  | 385 → 259      |
  | `17_afifo` × 4 (`--tile 2`)  | 34.7 M → 9.2 M  | 10.1 → 3.0  | 4.9 → 1.0  | 16.7 → 16.7  | 1466 → 1059    |
  | `17_afifo` × 16 (`--tile 4`) | 139 M → 36.8 M  | 35.1 → 9.1  | 18.1 → 1.0 | 50.0 → 16.7  | 7136 → 4298    |
  | `16_mem` × 16 (`--tile 4`)   | 132 M → 35.8 M  | 33.6 → 9.1  | 17.6 → 1.1 | 49.9 → 16.7  | 6390 → 4611    |

  At twice the pixel ratio `17_afifo` × 4 went from 33.3 to 16.7 ms per frame. A close view
  along the ground (elevation 10°) of `17_afifo` draws 5.66 M triangles instead of all 8.68 M.
  Draw calls for the × 16 designs fell from 8,247 to 2,148 (routing batches grow with the
  design). Frames that regroup placements cost more CPU: p95 2.3 ms on `17_afifo`, 20 ms on
  the × 16 design (261,280 placements). The first GPU workload after loading a tiled design
  sometimes read 12 ms instead of 3 ms for the same frames; later workloads did not.
  Images: eight views of each of the four designs were read back from both renderers. On the
  registers they match within 0.06 % of the drawn pixels except the top view (walls of far
  cells, one pixel wide) and one view from inside a metal shape, which used to show the
  shape's inner walls and now shows the scene. On `16_mem` and `17_afifo` 14 to 39 % of the
  drawn pixels of the fit, top and middle-distance views differ, from walls under two pixels of
  far cells; side by side the frames could not be told apart by eye. Dropping walls of far
  wires was tried and removed: it visibly paled the routing.
  Browser tests (`tests/solid.spec.ts`): a plain and a mirrored placement and a top shape are
  closed from two sides and from below, and from far above the two placements send 6 indices
  each. `tests/workspace.spec.ts` delays animation frames by 40 ms and sees the 3D canvas at
  half width during a drag and at full width afterwards. The release CLI answers
  `layout_solid` for `17_afifo` in about 50 ms (GDS read 34, evaluation 11, serialization 6),
  so the GDS was not cached; the 744 ms above was a debug build.

- **Editor (browser test).** Draw a rectangle, set 80 × 60, give three ports sides, see
  the same values in Project Settings, change the width there to 90 and see it in the
  view, drag `fast` above `slow` on the right side, save: the project file holds the
  outline and the pins in the new order.

Not checked: a real run with DRC violations or an LVS mismatch (the collector is tested on
fixture files only, and Netgen's mismatch lists are read as the fixture has them);
the mask view compared side by side with KLayout's own window (only against a headless
KLayout render by eye); KLayout's built-in stipples other than solid and hollow, which
neither PDK uses; a GDS with magnified or non-quarter-turn placements (the reader reports
them as errors by design) or with arrays (none in a place-and-route GDS; covered by unit
tests only); a layout larger than `17_afifo` in the view; a flow stopped by pin slots or by
routing congestion; the 3D tab inside the Tauri window (no desktop automation; the WebGL2
probe of the layout view stands), the 3D view's speed on an integrated GPU or in WebKitGTK
and its half-resolution mode on a GPU that is really slow (only with delayed frames), a 2.5D script using DRC operations outside the subset
(reported as unavailable by design), booleans across the hierarchy, GF180 (no 2.5D script),
and the 3D view's z ranges against KLayout's beyond the by-eye comparison. The later GDS
viewer qualification below covers the actual Tauri layout pane.

## GDS viewer precision, lifecycle and performance

10 October 2026, production mask renderer and preparation worker, current saved physical
artifacts. This supersedes the mask-view navigation measurements above. The viewer keeps
actual cell geometry at every zoom, projects camera-relative high/low DBU coordinates, and
presents masks and overlays in one animation frame.

- GPU transform-feedback regressions execute the production shader with all eight orientations,
  top-level and instantiated geometry, origins at −90,000,001, 90,000,001 and 2,147,483,001 DBU,
  fractional pans, zoom limits 0.01–2000, and display scales 1, 1.25, 1.5 and 2. Projected
  error stays below 0.25 device pixel. Pixel readbacks check coincident edge motion, exact
  return to the original camera, layer visibility, and context restoration. Additional
  coverage checks two-DBU gaps in cells with large local coordinates.
- The CLI-backed browser workflow loads an actual fixture GDS and layer file, pans/zooms,
  picks a wire, resizes at fractional display scale, toggles layers, reopens the pane, and
  delays a real mask response across snapshot changes. Every mask frame has its overlay in
  the same callback and at the same backing size; reopening causes no layout refetch or
  second preparation worker. A static-BVH regression checks inclusive viewport boundaries
  against a brute-force query and retains whole crossing polygons and original outlines.
- `tools/check-mask-geometry.py` checks coordinate/orientation placement multisets and XOR
  polygon coverage against KLayout 0.28.8, including recursive cell geometry. All comparisons
  have zero differing DBU²: SKY130 register, 92 placements / 264 layer-cell comparisons;
  IHP register, 89 / 208; SKY130 FIFO, 16,330 / 1,980. Shape counts alone are not the oracle.
- Tauri/WebKitGTK 2.50.4 loaded the real FIFO through native IPC. Pointer-centered wheel zoom,
  real pointer pans and reversal, layer toggles, pane reopening, window resize and context
  loss/restoration completed without page or GL errors. One preparation worker was retained
  across pane switches; masks and overlays shared all observed frame IDs and dimensions.
  Antialiasing was enabled in the actual context, with four multisamples after restoration.
  WebGL2's drawing-buffer requirements are specified in the [Khronos specification](https://registry.khronos.org/webgl/specs/latest/2.0/#THE_DRAWING_BUFFER).
  PDK bitmap patterns remain screen-based, independently of moving polygon edges.

`tools/benchmark-masks.mjs` measures the physical viewer separately from schematic layout.
It runs 65 frames per workload and discards five warm-up frames. First-visible timing starts
when an already decoded `MaskData` is posted to the worker and ends at GPU completion; it
excludes GDS parsing and IPC. Worker preparation includes startup, triangulation, BVHs and
transfer. Steady-frame timing never waits synchronously for the GPU; GPU duration uses
`EXT_disjoint_timer_query_webgl2` when available. Submitted index references count both fill
and outline passes, including instance multiplicity; they are not unique mesh vertices.

FIFO, 1100 × 700, Chromium on NVIDIA RTX 3060 Laptop GPU, all initially visible PDK layers:

| Workload         | CPU p95 | GPU p95 | Frame interval p95 | Submitted index references | Upload bytes / warm frame |
| ---------------- | ------: | ------: | -----------------: | -------------------------: | ------------------------: |
| Fit              |  2.6 ms | 3.04 ms |            16.7 ms |                 13,038,230 |                   326,620 |
| Detail, 40 px/µm |  0.2 ms | 1.88 ms |            16.8 ms |                    171,958 |                     2,240 |
| Deep, 2000 px/µm |  0.2 ms | 0.56 ms |            16.8 ms |                     40,466 |                        60 |

Preparation: 214 ms; first visible GPU-complete frame: 282 ms, including 56 ms for initial
GPU setup/drawing/completion. Warm navigation performs no GPU buffer allocations or mesh
preparation. Deep-zoom submissions are about 96% below the prior ~973,000 vertex submissions.
The raw local report is `.hdlview/benchmarks/masks-hardware.json`.

The same workload with headless Chromium/SwiftShader is separately recorded in
`.hdlview/benchmarks/masks-software.json`: preparation 220 ms; first fit draw plus GPU completion
1,800 ms; warm frame p95 at Fit/detail/deep is approximately 2,000 / 150 / 50 ms. GPU timer
queries were unavailable. Keeping all actual geometry at Fit remains expensive in software.

The isolated Tauri session required `WEBKIT_DISABLE_DMABUF_RENDERER=1` after default startup
failed with `EGL_NOT_INITIALIZED`; software forcing was not enabled. The WebKit process loaded
the NVIDIA driver and `/dev/nvidia0`; its WebGL renderer string was privacy-masked as `Apple GPU`.
An alternating zoom sequence at approximately 166 px/µm measured CPU callback p95 3 ms and
frame interval p95 21 ms (`.hdlview/benchmarks/masks-tauri.json`); GPU timer queries were absent.
**The native 16.7 ms p95 target is not yet qualified on this compatibility path.** Browser
hardware results cannot substitute for it. The default DMA-BUF path, native display-scale
changes, and native first-pane-to-screen latency remain unmeasured. Runs were on a shared
development workstation, not an isolated performance lab.

## Waveform navigation, saved trace list and measurement

10 October 2026, counter fixture, native toolchain, Chromium through the browser suite.

- **Next edge** from the start of the trace put the cursor on 5 ns and then 10 ns of the
  5 ns half-period clock, **Previous edge** returned to 5 ns, and the value column showed
  `1` then `0` for the clock. The same times read `5000 ps` with the unit set to ps.
- Shift+click on the ruler moved cursor B; the times of A and B and their difference
  are always in the toolbar.
- Ctrl+wheel changed the window and one new `wave_window` followed; a left drag zoomed to
  the dragged range without moving the cursor. A plain click still causes no
  `wave_window` (existing check).
- A per-row radix, a renamed divider, the cursor and the expanded rows were all present
  after reloading the page and reopening the project. **Set B** put cursor B on A
  (difference 0); cursor A then followed a drag along the ruler, and one clock half-period
  from B read `Δ 5 ns · 200 MHz`. With B chosen, **Next edge** moved B to 10 ns and left
  A at 5 ns. Alt+Down moved
  the selected row and dragging its name moved it back.
- Unit tests cover exact time text above 2^53 ticks, ruler steps, zoom about an anchor,
  pan limits, the saved list (including damaged entries) and the new radixes. Rust tests
  cover the edge query on a scalar and on one bit of a vector, with a repeated value in
  the dump, and the parsed timescale.
- Not run: the trace list carried across a second simulation run (it is read by the same
  code as after a reload, but only the reload was exercised); middle-button pan, the
  name-column resize, dragging B by its flag and colours; `wave_edge` on a
  joined gate vector of `17_afifo`; pinch zoom and wheel smoothness in the Tauri
  (WebKitGTK) window; traces larger than the fixture.

## Example testbenches without their own dump

10 October 2026. The 18 bundled testbenches no longer call `$dumpfile` and
`$dumpvars`: with them, Icarus ignored HDLView's dump request and printed one "VCD
warning" per DUT scope on every run. All 18 examples build at Elaborated RTL and
simulate on the native toolchain, each writing HDLView's `trace.vcd` with no
diagnostics and no "VCD warning" in the logs. Run by hand outside HDLView, these
testbenches now produce no waveform. A user testbench that dumps its own file is
still accepted as before, with the same Icarus warnings.

## Rebuild and interaction speed

Measured 9 October 2026 on the 30-cell counter fixture and the 1,000-node layout
benchmark, after caching tool probes, taking the camera out of the React render, keeping
the layout worker, and giving each waveform its own lock.

| Case                                          | Before       | After                       |
| --------------------------------------------- | ------------ | --------------------------- |
| Docker Elaborated build, first in a session   | 4.1 s        | 4.3 to 4.9 s                |
| Docker Elaborated rebuild after a source edit | 4.1 s        | 0.55 s                      |
| Docker Elaborated rebuild, nothing changed    | not measured | 0.04 s, no new directory    |
| Native Elaborated rebuild after the first     | 0.47 s       | 0.10 s                      |
| 1,000-node layout, first / repeated           | 1.6 to 1.9 s | 1.6 to 1.8 s / 1.4 to 1.5 s |

- Tool versions and the `read_slang` capability are probed once per toolchain identity
  per application session: the resolved Docker image digest, or the size and
  modification time of each native executable and plugin. **Check toolchain** always
  probes again. A native Python package changed in place is not detected until then.
- A snapshot-cache hit removes the build directory it had just captured. Failed builds
  keep theirs, because the error message points at its logs.
- Panning and zooming write one transform attribute and render nothing in React; pin hit
  areas and label detail are redrawn only when the zoom crosses a power of two. Not
  profiled in the Tauri window.
- Layout bends, crossings and size are unchanged (998 and 1,996 bends, 0 crossings).
- Waveform queries no longer hold the service lock. Decoded signals are kept for the 512
  most recently used instead of only the last request, and only the shown value of a
  busy pixel is formatted. The concurrency change has no automated test; the cache and
  decimation do.
- **86 Rust tests** and **45 frontend tests** pass; all **17 browser tests** pass on the
  native toolchain; `tools/qualify.py --schematics` passes 86 of 86 native cases.
  Docker mapped and post-layout qualification was not rerun for this change.

## Small designs, several clocks and package imports at the gate stages

Measured 9 October 2026 on the Docker image with
`tools/qualify.py --schematics --mapped --physical`, which now builds, views and
simulates every bundled example at Elaborated RTL, Mapped gates and Post-layout, beside
the fixtures on both PDKs: **251 of 251 cases pass.**

- **Post-layout: 19 of 20 builds complete**, including all 18 examples with no LibreLane
  overrides. Eight of them were small enough that core utilization was lowered so the
  power grid fits; `00_mux` goes from 30 % to 12.4 % on SKY130 and to 19.2 % on IHP
  SG13G2. The twentieth, the `counter` fixture on IHP SG13G2, ended with 16 Magic DRC
  errors. All 16 are Magic's pSD.i and pSD.j tap-spacing rules inside the eight
  `sg13g2_tiehi` library cells, and IHP's KLayout deck reports 0 on the same layout.
  IHP builds therefore no longer run Magic DRC (KLayout DRC still runs; `RUN_MAGIC_DRC`
  in the overrides turns it back on); rebuilt that way, the fixture completes with 0
  KLayout violations and its Icarus simulation passes.
- **Verilator is refused for gate-level simulation.** Running all 18 examples under
  Verilator showed that it does not model standard-cell flip-flops correctly on either
  PDK. In isolation, three flip-flops in series (`sky130_fd_sc_hd__dfxtp_2`, and
  `sg13g2_dfrbpq_1`) show `111` after one clock edge where Icarus shows `100`:
  Verilator 5.042 updates the cells' sequential primitives at once and ignores their
  delays, for any `UNIT_DELAY`. At Mapped gates `11_fifo`, `15_sync_ff` and `17_afifo`
  failed for this reason, and the counter fixture passed only by its structure. IHP's
  resettable flops are additionally held in reset, because Verilator leaves the delayed
  signals of `\$recrem` timing checks undriven. A gate snapshot with a Verilator
  configuration now stops with a message to use Icarus, and the application greys
  such configurations out on Mapped gates and Post-layout schematics.
- **Verilator at Elaborated RTL: 16 of 18 examples pass** (18 of 18 under Icarus).
  Fifteen failed before this change because the generated `defparam` into the
  testbench hierarchy is not accepted by Verilator; for Verilator the harness now
  checks at time zero that the testbench gives the DUT the project's parameter values.
  `07_comparator_N` and `08_alu` still fail: their checkers use
  `always @(*) begin #0.1 ...`, which runs every 0.1 ns under Verilator and so samples
  outputs in the instant the inputs change. That reading comes from the log pattern and
  was not isolated further; the testbenches are left unchanged.
- **Several clocks:** `17_afifo` with `wr_clk_i` and `rd_clk_i` completes Post-layout.
  The generated constraints create both clocks and one asynchronous group, clock-tree
  synthesis builds both trees, and none of the post-route timing reports lists a path
  from one clock to the other. With `related_clocks` set the group statement is absent
  and the flow also completes; the reports list only worst paths, so the presence of
  cross-clock paths was not confirmed from them.
- **Packages:** `08_alu`, whose testbench imports `alu_pkg`, now simulates as mapped
  gates and at Post-layout.
- **92 Rust tests** and **47 frontend tests** pass; all **17 browser tests** pass on the
  native toolchain. The additional-clock controls have unit tests but no browser test.

## Designs without a clock, and example project files

Measured 9 October 2026 on the Docker image. The clock port of a physical configuration
is now optional; the period stays required. Without a port LibreLane times the design
against a virtual clock of that period and skips clock-tree synthesis.

- `tools/qualify.py --schematics --mapped` now also builds, views and simulates every
  bundled example as SKY130 mapped gates: **165 of 166 cases pass**, including the nine
  combinational examples and both PDKs for the fixtures.
- The one failure is `08_alu` mapped-gate simulation: its testbench imports `alu_pkg`,
  a design source that a gate simulation does not compile. The build and schematic
  pass. Not fixed.
- `00_mux` Post-layout with no clock port completes (clock-tree synthesis skipped, nine
  SDF corners), and both the plain and the SDF-annotated simulation run. It needs a
  fixed 60 µm die: at the default relative sizing the power grid does not fit
  (`PDN-0185`). That is a small-design limit, not a clockless one; the other examples
  were not run at Post-layout.
- All 18 examples carry a physical configuration, and examples and fixtures are stored
  byte-for-byte as HDLView saves them. A Rust test checks this and Prettier no longer
  covers those files.
- **89 Rust tests** and **46 frontend tests** pass; all **17 browser tests** pass on the
  native toolchain. The empty clock-port field has unit tests but no browser test.

## Parameterised testbenches on gate netlists

Measured 9 October 2026 on the Docker image. `examples/10_linear_feedback_shift_register`
failed mapped-gate simulation with "parameter `N` not found", because its testbench sets
`N` on the DUT and a netlist has no parameters. Gate simulations now compile a copy of
the netlist whose top declares the built parameter values (read with pyslang from the
captured sources) and checks each one.

- The example builds and simulates as SKY130 mapped gates with Icarus.
- With the testbench value changed to 4 against a build with 8, Icarus stops at
  elaboration with "simple_lfsr was built with N = 8; the testbench sets another value".
- SKY130 gate runs without SDF now define `UNIT_DELAY=#0.01` unless the configuration
  sets it. The 58 Icarus "macro UNIT_DELAY undefined" warnings are gone, and the example
  and the `counter` fixture pass mapped-gate simulation with Icarus. A configuration
  with `UNIT_DELAY=#1` also passes. Post-layout without SDF was not rerun. (Verilator
  gate runs recorded here at the time were later found unreliable; see the newest
  section.)

## Representation and format reduction

Measured 9 October 2026 after removing the Source RTL and Generic gates representations,
project schemas 1 and 2, the snapshot schema before 2, and the hand-written cell table.
Later sections are dated records of earlier runs; where they mention those removed
features, they describe the application as it was then.

- **84 Rust tests** and **45 frontend tests** pass, with formatting, Clippy
  (`-D warnings`), ESLint, Prettier and TypeScript clean. New tests cover rejection of
  other project and snapshot schemas, the reserved captured-input namespace, and
  supply-only library cells.
- `tools/qualify.py --schematics` on the native toolchain: **86 of 86 cases pass**. It
  builds, views and simulates the three fixtures and all 18 bundled examples at
  Elaborated RTL: 0 pseudo-nodes, 0 unknown symbols, 474 declared signals intact.
- The same with `--mapped` on the Docker image: **94 of 94 cases pass**, including mapped
  builds and zero-delay gate simulation for SKY130 and IHP SG13G2, with 0 unknown
  symbols (29 and 40 visible cells). Library functions now come only from Liberty: 422
  of 446 SKY130 library modules and 80 of 84 IHP modules carry one, and the 18 SKY130
  fill, tap and `sky130_ef_` cells absent from Liberty are physical by their
  supply-only interface.
- One full SKY130 post-layout build of the counter on the Docker image completed
  (266 cells, 213 fill, decap and tap cells hidden, 53 visible, 0 unknown), unchanged
  from the previous run, and its SDF-annotated timing simulation ran. IHP post-layout
  was not rebuilt.
- The 1,000-node layout benchmark takes 1.7 to 1.9 s with the same bend and crossing
  counts as before.
- All **17 browser tests** pass on the native toolchain. The symbol gallery has 27
  reviewed symbols; the three behavioural ones were removed.

## Quartus-style schematic qualification

Measured 9 October 2026 with `tools/qualify.py --schematics`, which now also builds and
views the top scope of every bundled exercise at Elaborated RTL and records cell,
pseudo-node (off-view connector), unknown-symbol and declared-signal
counts. It asserts that every declared signal of the raw elaborated netlist keeps its
name and width in the drawn netlist.

**View cleanup.** Across the counter, Verilog and showcase fixtures and the 18 exercises
(native Yosys 0.62 with the Slang plugin):

| Top-scope total  | Before | After |
| ---------------- | ------ | ----- |
| Cells            | 192    | 170   |
| Pseudo-nodes     | 132    | 18    |
| Unknown symbols  | 0      | 0     |
| Declared signals | 474    | 474   |

`11_fifo` accounts for most of the change: 107 pseudo-nodes became 3, because its
32-bit increments are narrowed to the bits in use. The counter fixture's lane is one
adder and one `$sdffe` titled `count`; `01_simpleRegister` is one `$adff`;
`09_shift_register` is one `$adffe`. The same script produced the same cell types for
the counter, `11_fifo`, `01_simpleRegister` and the showcase on the Docker image's
Yosys 0.60.

Limits: a register whose D input is itself a declared net keeps its multiplexers in
front, which is what the source describes. Counts cover the top scope only; hierarchical
exercises have further cells in child scopes. `08_alu` barely changes because its case
multiplexers are not folded by this step.

**Net model, layout and symbols.** Geometry version 5. After the net model, the same
sweep reports **0 pseudo-nodes** in every view, with 474 declared signals intact.
Exported Elaborated RTL schematics of the top scope, built and laid out in the real
browser worker and measured as SVG width × height including a 20-unit margin:

| Design               | Before       | After       |
| -------------------- | ------------ | ----------- |
| counter fixture      | 1263 × 444   | 875 × 303   |
| `09_shift_register`  | 1294 × 683   | 739 × 282   |
| `10_linear_feedback` | 1491 × 655   | 887 × 366   |
| `11_fifo`            | 4185 × 14350 | 1592 × 1089 |
| `08_alu`             | 2866 × 5470  | 1868 × 2683 |
| `16_mem`             | 1590 × 969   | 872 × 353   |
| showcase fixture     | 2725 × 3144  | 1233 × 1144 |

In each of these the registers are drawn after the logic computing their input; before,
the counter, shift register and FIFO placed a register in the first logic layer with its
feedback wrapped around the drawing. `tools/benchmark-layout.mjs` laid out its two
synthetic 1,000-node graphs in **1.84 s** (mixed, 998 bends, 0 crossings) and **1.62 s**
(high fan-out); the previous layout measured 1.85 s and 1.59 s on the same machine, so
the three-second target still holds. The benchmark now records bends, crossings, wire
length and area.

- **68 Rust tests** and **45 frontend tests** pass. New cases cover bus nets and feeds,
  slice and replication labels, cut-bus connectors, a grouped multiplexer's constant
  input, pin sides, routed terminals on all four sides, joins, inline constants,
  bidirectional pads, and the relational readability checks.
- All **17 browser tests** pass with the native profile. The reviewed light and dark
  symbol-gallery baselines were refreshed for the new geometry.

**Case multiplexers and instance roles.** `08_alu` folds both of its eleven-way case
statements into `MUX 11:1` symbols selected by `opcode_i`; its exported top scope went
from 1868 × 2683 to 1560 × 1337. The showcase's case statement is one `MUX 4:1`, its
memory shows only the five pins in use, and its export went from 1233 × 1144 to
1061 × 947. In the counter fixture, `clk` and `reset` reach only clock and reset pins
inside both `lane` instances and are drawn as connectors. 71 Rust tests cover the fold,
its rejection when a comparison is shared, per-case pins, instance roles through a
nested instance, and unused memory controls. All 17 browser tests pass.

**Library cells.** `tools/qualify.py --schematics --mapped` on the Docker image (Yosys
0.60, LibreLane 3) passed all 82 cases. Reading the mapped Liberty library as logic
described 404 of the 446 SKY130 library modules and 80 of the 84 IHP modules present in
the snapshots; a local run over the libraries LibreLane hands to synthesis described 190
of 192 SKY130 cells and 78 of 79 IHP cells in under 20 ms, leaving only the full adders,
which have two outputs. In the mapped counter:

| Counter fixture    | Visible cells | Unknown before | Unknown after |
| ------------------ | ------------- | -------------- | ------------- |
| SKY130 mapped      | 29            | 4              | 0             |
| IHP SG13G2 mapped  | 40            | 2              | 0             |
| SKY130 post-layout | 53            | 23             | 0             |

The post-layout figures are from one full LibreLane run on the Docker image (status
complete, 266 cells, 213 fill, decap and tap cells hidden). Its 19 delay and clock-delay
buffers, previously boxes, are drawn as buffers. IHP post-layout was not rebuilt.

The four SKY130 cells that were boxes (`a31o`, `a41o`, `and2b`) are now AND-OR compounds
with their inner gates and an AND with one bubble; flip-flops are titled `fast[0]` to
`slow[3]`, and the IHP `dfrbpq` shows `RESET_B` as an active-low asynchronous reset
below the symbol. 75 Rust tests cover the decoder on gate networks copied from the real
libraries and its refusal to name a function it cannot match.

Limits: boundary ports are no longer in declaration order, and a port whose only net is
drawn as a control connector is placed by model order alone. Placing registers after
their logic costs a few bends in loop-heavy designs. A net name is omitted where its
driver's first run is short or crossed, so some declared nets are named only in the
tooltip. Pin text is still sized by character count, not measured. A module instance is
titled with the compiler's specialised name, such as `lane$counter.first`. Library
cells with more than six inputs or more than one non-constant output, and latches whose
reset Liberty models as logic, are not decoded: the former stay labelled boxes and the
latter show that pin as data. A clock that passes through clock-tree buffers is wired,
not drawn as a connector, because roles are not traced through buffers.

## Bundled SystemVerilog exercises

The public examples now contain exercises `00_mux` through `17_afifo`, with 50
required RTL/package/testbench files and 18 portable schema-3 configurations.
The configurations use the original Makefile parameter/define defaults, Icarus,
and a 2 µs limit. No physical constraints or machine-specific tool paths are added.
The counter, Verilog range and schematic showcase fixtures moved to
`tests/fixtures/`; their contents remain byte-for-byte unchanged.

- All **72 source/elaborated workflows** pass through the actual HDLView CLI:
  18 projects × two representations × native/Docker providers. Checks include
  graph endpoint connectivity, simulation snapshot/stage binding, testbench
  assertion output, Wellen waveform parsing, exact DUT scope and trace provenance.
  All testbenches finish before the harness limit.
- **12 binding checks** cover the mux, hierarchical ALU and asynchronous FIFO
  in both representations and providers. Their public ports have exact bindings;
  compiler-only/generated internal signals retain explicit unavailable statuses.
- The native tools are Yosys **0.62+9**, pyslang **10.0.0** and Icarus **13.0
  development build**. Docker uses `hdlview-tools:2025.12`, image
  `sha256:26f11a10c89c2e5416a57ff73ec7f514fc2204d35078da46517bb1461bc2cc0d`,
  with Yosys **0.60**, pyslang **10.0.0** and Icarus **13.0 development build**.
- Hash checks confirm the external originals are unchanged. The copied
  `15_sync_ff` testbench alone seeds its expected-value queue with the reset
  value, preventing an empty-queue startup comparison. Its **101 checks pass**
  in both providers and representations without disabling assertions.
- All **17 browser regressions pass with each provider** after relocation,
  and `tools/qualify.py --schematics` passes **38 native checks** using the
  retained fixtures. Frontend ESLint, formatting, TypeScript and **40 unit tests**
  pass. Python tooling syntax and final source/fixture hash checks also pass.

The existing generated-hierarchy binding limitation described below remains; no name
guessing is introduced.
This qualification does not claim gate/physical compatibility for every exercise,
and no physical flows were rerun. Local reports are
`.hdlview/examples/{native,docker}-results.json` and `.hdlview/examples/bindings.json`.

## Schematic clarity and workspace qualification

Geometry version 3 uses compact boundary columns, centered side labels, shared
border anchors and square pin terminals. Electrical routes are normalized only
within original net/slice identities; round dots indicate actual branches, not
bends, terminals or unrelated crossings. The camera transforms both grid spacing
and origin; pin/wire selection remains presentation state. Sources, Design and
Inspector share the left sidebar. Waveforms, Logs and Problems share one full-width
bottom panel with independent scrolling and constrained, keyboard-accessible
resize handles.

- **77 Rust tests** (66 core, 11 identity) and **40 frontend tests** pass; workspace
  formatting/Clippy with denied warnings, frontend formatting/ESLint/TypeScript
  and production compilation pass. Coverage includes compiler port order,
  ascending/descending nonzero bus ranges with unchanged bit IDs, actual ELK
  endpoints for every symbol family, disconnected columns/inouts, shared trunks,
  multiple-driver junctions and foreign crossings. Missing, malformed, wrong-scope,
  ambiguous and symlinked trace candidates fail safely.
- All **17 browser workflows pass with each provider**, native and Docker, including reviewed light/dark gallery
  fixtures, camera-relative grid pan/zoom/Fit/coarse levels, exact terminal versus
  wire/keyboard selection, exports without hits/grid, both simulators with named
  traces, shared sidebar views, full-width panel tabs, independent scrolling,
  pointer/keyboard size limits, narrow windows and preserved camera/editor/waveform
  state. Inspector changes only when explicitly selected.
  Loaded grouped selection measured **38–56 ms**, including click/assertion overhead;
  worker instrumentation confirms presentation changes do not start layout.
- A temporary copy of the reported `04_adder_N` project builds and simulates with
  Icarus 13 and Verilator **5.045 native / 5.042 Docker**. All four runs collect
  the testbench's `adder_N.vcd`, verify `hdlview_sim.adder_N_tb.i_adder_N`, and
  record its actual path/hash in run and manifest. Traces contain **63 Icarus /
  55 Verilator variables**, ending at **102,000 ps**. Hash checks confirm the
  original external sources/configuration were unchanged. Local evidence:
  `.hdlview/clarity-adder-{native,docker}.json`. A native Icarus testbench-named
  `counter.fst` also collects successfully with **20 variables / 132,000 ps**;
  `.hdlview/clarity/fst.json` records the actual path/hash.
- Real Chromium worker benchmarks on the documented workstation measured
  **1,945.6 ms mixed symbols** and **1,813.4 ms high fan-out** for 1,000 nodes /
  999 edges, including the new normalization step. These satisfy the three-second
  fixture target, not a guarantee for arbitrary routing. Raw results remain in
  `.hdlview/benchmarks/layout-result.json`.

The production Debian package passes CLI trace parsing, runtime dependency resolution,
and an isolated 11.27-second startup with empty stderr. A native GTK picker in the
packaged application reopens the adder snapshot and its matching testbench-named
trace. The desktop smoke covers the working testbench editor, shared Inspector
with an exact root-level `b_i` binding, all three bottom-panel views, pointer and
keyboard resizing, and the 1000×650 minimum window. Switching panels retains cursor
23,800 and range 0–51,000. Native SVG export contains 75 square terminals in 73,623
bytes and excludes hit regions, selection, grid and hover/focus rules. Local evidence:
`.hdlview/package-smoke-results.json` and
`.hdlview/clarity/workspace-desktop-smoke.json`. Final size-limit regressions also
pass with both providers after the full suites.

Generated adder instances still expose an existing binding limitation: Yosys stores
`gen_full_adders[0].i_full_adder` as one hierarchy segment, while the trace uses
separate scope segments. Those internal endpoints remain unavailable rather than
being guessed; root-level bindings and collected waveform data are valid.

A feasibility run using a cache directory containing spaces exposed Verilator's
GNU Make restriction on build-directory spaces. The actual adder and browser
qualification use space-free artifact caches, while working projects may reside
in paths containing spaces and are captured normally. This change does not
introduce a Verilator build-directory workaround. No physical flow was rerun and
no project/artifact schema or dependency was changed.

## Professional schematics qualification

The renderer now shares original SVG geometry and fixed anchors with the ELK worker.
Raw cell parameters, optional captured behavior and display metadata are additive;
project schema remains 3. Unsupported source constructs/library interfaces stay explicit.
The reviewed light/dark gallery covers 30 examples of logic, selectors, sequential,
operator, memory, behavioral, hierarchy, unknown, directional-port and constant symbols.
No new dependency or copied reference skin is distributed.

Repeatable checks: run the Rust/frontend commands in README, the browser suite with a
qualified native/Docker profile, and `tools/qualify.py --schematics` (`--mapped` for PDKs).
The latter checks symbol families, captured sequencing/calls/targets, endpoint connectivity
and real testbench results. Source memory aggregates can still be opaque; elaborated
memory interfaces use compiler metadata. Recognition is intentionally bounded: binary
mux trees up to 63 members, decoder inputs up to five bits and complete constant-code
priority chains. No recognition is applied across mapped gate instances.

- **73 Rust tests** and **37 frontend tests** pass, including legacy optional metadata,
  polarity, exact cell interfaces, bus/routing identity, bounded views, grouping and atomic
  SVG publication. Rust formatting/Clippy, frontend formatting/ESLint/TypeScript and
  production compilation pass.
- All **16 browser workflows** passed with native and Docker providers across the
  qualification runs, including the two reviewed symbol-gallery images. Actual tool-backed
  checks covered source detail and call navigation, parent camera restoration, compiler
  nodes, theme/export, unchanged bindings, and waveform selection into a collapsed mux tree.
  A concurrent Docker run exceeded the existing five-second file-creation layout wait;
  that test passed after adopting the normal 40-second tool/layout timeout.
- `tools/qualify.py --schematics` completed **38 native checks** and **46 Docker checks**
  with `--mapped`, including exact exported netlist simulation for SKY130 and IHP.
  The counter, Verilog and mixed showcase fixtures built and simulated successfully.
  Existing SKY130 post-layout artifacts reopen without changing their bytes/hashes;
  **213 physical-only cells** are hidden by classification. No full physical flow was
  rerun. The available historical IHP physical example is VHDL and remains unsupported;
  it is not evidence of current IHP post-layout qualification.
- The Debian package passes CLI waveform parsing, runtime dependency resolution and
  isolated desktop startup with no stderr. An interactive host smoke exercised native
  project selection, Docker elaboration/simulation, hierarchy navigation, both schematic
  themes, native SVG saving, and close/reopen restoration. Standalone exports were parsed
  as XML and checked for embedded styles and absence of transient selection/hit overlays.
  Generated package/smoke evidence remains under ignored `.hdlview/` and `target/`.
- On this Linux workstation (Ryzen 5 5600H, 12 logical CPUs, approximately 16 GB RAM,
  SSD, kernel 6.8.0), a real Chromium worker laid out **1,000 nodes / 999 edges** in
  **1,842.4 ms** for mixed symbols and **1,582.0 ms** for high fan-out. Loaded grouped
  selection measured **30–52 ms**, including Playwright click/assertion overhead; worker
  instrumentation confirmed selection/theme/cursor changes did not start layout.
  These are fixture measurements, not guarantees for arbitrary routing or full
  Tauri-to-screen latency. Raw layout results are in `.hdlview/benchmarks/layout-result.json`.

## Source explorer and file management qualification

The registered-entry explorer and working-file operations were exercised using
real temporary projects. File creation, rename, and Trash modify originals
immediately; project membership is published only by Save Project. Import
exclusions remain optional schema-3 metadata, omitted when empty; historical
snapshot/run files are not rewritten.

- **56 Rust tests** and **28 frontend tests** pass. Workspace formatting,
  desktop-inclusive Clippy with warnings denied, frontend formatting, ESLint,
  TypeScript, and production build pass. Core coverage includes empty/header/
  external creation, collisions and symlinks, stale project/disk previews,
  reference/order preservation, discovered-header tab mappings, missing-entry
  removal, folder/filelist exclusions, hidden Trash blockers, and bounded file-job
  retention.
- **All ten browser workflows pass with each provider**, native and Docker.
  Two focused workflows also pass with each provider after extending successful
  folder Trash and delayed-read coverage. They create/edit/build new RTL,
  preserve dirty buffers and undo history through rename, reuse former filenames
  without tab collisions, reject reads that complete after rename, cancel dirty-tab
  removal, persist empty folders, reopen saved projects, remove membership without deleting originals,
  and move registered files and nested folders to real isolated Trash. Existing
  editor conflicts, legacy loading, imports/rescans, live lint, immutable source,
  cross-probing, shared testbenches, and per-project restoration regressions pass.
  Browser pickers are injected; core filesystem and tool operations are real.
- The rebuilt Debian package passes CLI/runtime checks and an actual
  **native-picker/WebKit smoke on Xvfb**: create an empty SKY130 project, create
  an empty file with Ctrl+N, edit/save it, rename with F2, use Shift+F10 context
  actions, register an empty folder, Save Project, Close Project, and reopen
  through the JSON picker. The renamed source and empty folder remain available.
  Its declared dependencies include `libglib2.0-bin`. Local evidence:
  `.hdlview/source-files-desktop-results.json` and
  `/tmp/hdlview-files-desktop-smoke/` screenshots/logs.

GIO refused Trash on this host's separately mounted `/tmp` filesystem with
“Trashing on system internal mounts is not supported”; the failed operation left
the original and project membership intact. Successful Trash fixtures therefore
use the project filesystem and a separate `XDG_DATA_HOME`, without touching the
user's Trash. Mount-specific Trash availability remains a host limitation;
there is no permanent-delete fallback. The packaged smoke uses the documented
software-rendering/Unix-volume-monitor compatibility settings. These results
qualify this host, not every Linux distribution. No unrelated physical flows or
large-project explorer benchmarks were rerun.

## Live editor linting qualification

The live editor uses pinned pyslang **10.0.0**, Verible
**v0.0-3724-gdec56671**, and CodeMirror lint **6.9.5**. Both tools were exercised
through the normal core/service runner, using actual temporary projects and
unsaved buffers rather than mocked diagnostic responses.

- **45 Rust tests** and **24 frontend tests** pass. Rust formatting and
  desktop-inclusive release Clippy/tests pass with warnings denied, alongside the
  host core/CLI checks; frontend formatting, lint, TypeScript, and
  production build pass. Added cases cover Unicode/EOF ranges, engine timeout
  cleanup, bounded lint-job retention, background cancellation during close and
  user jobs, and HDL-only temporary include capture.
- **23 real-tool checks pass for each provider**, native and Docker. They cover
  syntax, unresolved names, ports, widths, BOM/CRLF, multiple unsaved headers,
  macro definition/expansion locations, external roots and duplicate basenames,
  configuration defines/DUT parameters, limited analysis, custom rules/waivers,
  unsupported style parsing, auxiliary/unregistered-unit exclusion, malformed rules, independently missing engines,
  1,000-diagnostic truncation, and correction without saving. Every check verifies
  unchanged original sources/configuration, removed temporary inputs, and only
  one retained lint job. Reports: `.hdlview/lint-native/results.json` and
  `.hdlview/lint-docker/results.json`.
- **All eight browser workflows pass with each provider**, preserving project
  imports/conflicts/restoration, immutable captured sources, instance/bus selection,
  stage binding, and shared testbenches across RTL/gates. The editor workflow checks
  unsaved underlines, Problems navigation, F8/Shift+F8, simultaneous headers,
  configuration changes, local settings across reopening, immediate invalidation,
  and rejection of a deliberately delayed real-tool result. Focused reruns
  additionally verify undo/redo after diagnostics. Pickers are injected in browser
  tests; backend operations use real files.
- The rebuilt Linux Debian package passes runtime/CLI startup checks and an actual
  **native-picker/WebKit editor smoke on Xvfb**. Its working editor displays semantic
  and style underlines/gutter markers, opens Problems, navigates ranges, corrects
  errors without saving, and discards the dirty buffer during Close Project.
  Originals/configuration remain unchanged, no snapshots are created, and lint
  temporary copies are removed. Local evidence:
  `.hdlview/editor-lint-desktop-results.json`, `.hdlview/package-smoke-results.json`,
  and `/tmp/hdlview-lint-smoke/` screenshots. This qualifies this host, not every
  Linux distribution. No unrelated physical flows were rerun.

On the workstation described below, a four-line design, included header, and one
testbench with two configurations produced browser feedback in **1.95 seconds
native** and **1.93 seconds Docker**, measured from replacement interaction through
visible error underlines, including the 750 ms debounce and preparation. Typical
backend requests including both engines took **0.18 seconds native** and **0.61
seconds Docker**. The 1,010-style-finding cap case took 0.73/1.16 seconds. These are
small-fixture observations alongside other development, not percentiles or large-
project guarantees; larger working-project capture/parsing remains to be measured
before introducing persistent workers.

Slang 10 accepts SystemVerilog-2017/2023 but not Icarus's 2012 dialect. Icarus
contexts therefore explicitly show limited analysis; simulator compilation is
authoritative. Unreferenced headers receive style checks with limited status,
and Verible parser limitations never become duplicate syntax errors or a clean
style result. Live inputs are `.v`/`.sv` and `.vh`/`.svh`; generated models/SDF and
captured tabs are excluded. Timed-out/missing engines are failures independent of
HDL diagnostics. The package builder initially lacked Clippy and its standalone
test invocation lacked the registry mount; verification reuses the host's matching
installed Clippy and registry read-only rather than changing the tool image.

A follow-up restoration regression reproduced a snapshot's old Docker image with
pyslang 9.1.0 overriding the configured image containing 10.0.0. Opening/building
a snapshot now preserves the configured profile for lint and new builds; existing
snapshot simulations retain their recorded profile. Native and Docker browser
regressions pass for profile preservation, unsaved undeclared identifiers, missing
semicolons, visible error markers, engine unavailability, and recovery. All 45 Rust
tests, desktop-inclusive Clippy, and the frontend checks/24 tests pass. The old
image also verifies the actionable version-mismatch message. The packaged smoke
above predates this follow-up; the package was not rebuilt for this fix.

The status-wording follow-up passes frontend formatting, lint, TypeScript,
production build, and **26 frontend tests**, plus the live editor browser workflow
with both native and Docker tools. It distinguishes incomplete/unavailable style
checks from semantic restrictions while retaining syntax errors and navigation.
This frontend change did not rerun Rust or packaged smoke checks.

## Linux compatibility launch

`npm run desktop:compat` was exercised with WebKitGTK 2.50.4 and GTK 3.24.33
in an isolated Xvfb session, with a separate development port and machine settings.
Actual Tauri startup, native JSON selection/cancellation, editor lint, Docker
elaboration/Icarus simulation, SVG schematics, and Canvas waveforms passed with
**zero EGL or GTK warnings**. The original renderer configuration reproduced EGL
warnings; using the default mount monitor reproduced GTK free-space warnings when
a short-lived Docker container started.

The compatibility launch uses Mesa software rendering and GIO's Unix volume monitor
as development troubleshooting options. CPU cost and desktop-managed volume
listing may differ; no graphics-performance benchmark or new package build was
performed. Evidence: `.hdlview/desktop-compat-smoke-results.json` and
`/tmp/hdlview-warning-smoke/` logs/screenshots. Repository formatting checks pass.

## Verilog/SystemVerilog-only qualification

The project contract is schema 3; source imports accept `.v`/`.sv` and `.vh`/`.svh`. The application supports VCD/FST and rejects other waveform formats, including renamed files.

- **39 Rust tests** pass, with workspace formatting and Clippy (`-D warnings`). Coverage includes legacy-source merging, canonical identity deduplication, preserved configuration-specific testbench order, transactional import failure, immutable legacy artifact restoration, revision checks, and SDF restrictions before job launch.
- **20 frontend tests** pass, including ordinary configuration availability across representations and SDF eligibility against the actual loaded snapshot. Frontend lint, TypeScript, and production build pass.
- **Seven browser workflows pass with each provider**, native and Docker. They use real temporary files and CLI operations; native picker selection is injected. Coverage includes creation/import/editor conflicts, ordered filelists, legacy migration, cancelled/failed opening, two-project restoration, source/snapshot immutability, instance/bus cross-probing, and one unchanged testbench/configuration across RTL and generic gates.
- The repeatable native matrix has **20 successful results**: source/elaborated/generic builds, shared Icarus testbenches, waveform parsing for both supplied language examples, and Verilator RTL simulation. The Docker `--mapped` matrix has **26 successful results**, adding SKY130 and IHP mapped builds and gate simulations with that same counter testbench. Local reports are `.hdlview/qualification-sv-native/results.json` and `.hdlview/qualification/results.json`.
- An existing Verilog/SystemVerilog SKY130 post-layout snapshot was reopened without changing its captured artifacts and simulated with its matching SDF. Icarus's unsupported timing-check warnings remain visible. No full physical flow was rerun for this change; the old IHP post-layout fixture is VHDL and is intentionally unsupported.

Qualification initially exposed pyslang 9.1's missing Verilog-2005 support. Both isolated helpers were requalified with pyslang 10.0.0, including model-interface extraction for both PDKs. An initial native retry used a Python-3.13 wheel with Python 3.10; installing the matching wheel in an isolated temporary directory fixed that test setup. The final matrices above contain the successful reruns.

Folder rescans preserve assigned roles and order. Filelist/capture/editor tests retain external-root hierarchy, duplicate basenames, skipped caches/symlinks, headers, BOM/CRLF, environment substitution, located errors, cycles, cancellation, and failed writes. These small workflows do not qualify every language or library feature.

The rebuilt Debian application also passed a native create/save/close/reopen smoke test on this host's isolated Xvfb display. The actual GTK directory and RTL/JSON pickers created a SKY130 project, imported a SystemVerilog working source, opened it in CodeMirror, saved an edit with Save Project, cleared the workspace on Close Project, and reopened the schema-3 configuration with its source hierarchy and default editor state. Browser tests above cover the corresponding schematic/waveform restoration paths. The smoke used isolated machine settings and `WEBKIT_DISABLE_DMABUF_RENDERER=1`; EGL warnings remain nonfatal.

The waveform-height amendment passed all seven native browser workflows, followed by a focused regression checking dragging in both directions. The tests cover pointer capture outside the divider, keyboard limits, visible-row growth, preserved cursor/selection, unchanged schematic view/layout work, minimum-window sizing, and default sizing after reopening. Frontend lint, formatting, TypeScript/production build, and 20 unit tests pass. This frontend change did not rerun physical flows or package qualification.

## Toolchain qualification findings

HDLView now runs the unmodified `hpretl/iic-osic-tools:2026.09` image (see "Stock image qualification" below); the derived image described here is no longer built.

The base `hpretl/iic-osic-tools:2025.12` image was pinned by digest in `tools/Dockerfile`. It contains mismatched generations of some flow tools. The derived image pinned:

- pyslang 10.0.0;
- LibreLane 3.0.0, invoked as `/usr/local/bin/librelane`;
- Magic 8.3.684, commit `4f53bb3091d1e4a9b2009a58f157a8a4331d4c84`;
- the base image's newer OpenROAD/OpenSTA executables, not the older `openroad-librelane` wrapper environment.

The base image's LibreLane 2.4.10 understands SKY130, but not the supplied IHP PDK's renamed PDN/cell-list variables. Its older Magic also lacks the `units` command required by LibreLane 3. These are reproduced compatibility findings, not inferred version requirements.

Docker profiles resolve a tag to a local immutable image ID before compilation. Every tool invocation records arguments, selected environment, working directory, exit code, duration, and logs. Snapshot inputs and netlist/SDF contents are fingerprinted and checked on reopening.

## Performance evidence

Workstation: AMD Ryzen 5 5600H (6 cores/12 threads), approximately 16 GiB RAM, Linux 6.8 / Ubuntu 22.04. Measurements occurred alongside other development work and are not controlled release benchmarks.

A 1,074,028,999-byte VCD (one 32-bit bus, approximately 24 million timestamps) parsed successfully in the debug CLI: **33.03 seconds**, maximum resident set **1,544,364 KiB**. See `.hdlview/benchmarks/vcd-result.json` for the local raw report. The parser operates in a killable subprocess in the desktop/service; cancelling this trace during indexing returned `cancelled` in 50.7 ms. VCD parsing is not assumed to be demand-loaded.

The same trace converted to a 113 MiB FST opened in **1.77 seconds**, with **408,464 KiB** peak resident memory in the debug CLI (metadata/time-table load; visible signal query cost is separate).

The synthetic 100,000-cell graph test limits the returned view to the 2,000 cells it asks for; the service default is 5,000. Selection does not request layout, and cursor queries are capped at 200 visible schematic signals. A real Chromium worker laid out a synthetic 1,000-node/999-edge graph in **1.75 seconds**. The initial default layout took 12.30 seconds; views above 400 nodes now use lighter layered placement and crossing heuristics. Cached 200-signal queries over parser-worker IPC measured **3.45 ms median**, **3.84 ms p95** over 50 queries. These are worker measurements, not full Tauri-to-screen latency. [Raw performance results](performance-results.json).

## Remaining limitations and release gates

- Windows support is unqualified; see "Windows port". On Windows only the Docker toolchain with the image's own PDKs is supported.

- Gate-level views and gate simulation need a PDK flow (the Docker toolchain); there is no technology-independent gate stage.
- RTL DUT overrides are generated as `defparam` assignments in an isolated harness. Gate simulation uses the already-specialized netlist; hierarchy probes and explicit parameter overrides inside a shared testbench may require user adjustments after synthesis.
- Waveform binding supports exact declared paths/ranges and explicit same-range manual mappings. General compiler-renamed aliases and arbitrary slice remapping are not yet inferred. Missing signals remain unavailable.
- Bus rows can expand to 256 individual bits. The schematic retains bus connectivity and pin identities; schematic buses can expand into individual routes, with a 20,000-pin-bit limit per view. Library cells the Liberty decoder cannot describe retain labeled boxes.
- Snapshot content is immutable by checked fingerprints, but artifact directories are not a relocatable archive format. Working inputs may use project-relative or registered-root references; captured inputs are local to the snapshot. Recursive imports skip directory symlinks, and VHDL inputs are rejected.
- Docker builds with image-contained PDKs use a content-addressed cache keyed by captured inputs, configuration, immutable image, tool versions, and application binary. Native installations and externally mounted PDKs conservatively rebuild. Layouts and visible waveform signals are cached; a disk-backed waveform index is not implemented.
- A native profile must include compatible model files, Python bindings, plugins, and PDKs. Native/Docker parity has been checked on small workflows, not exhaustively across all language/library features.
- Macro physical flows, broader PDK corners/models, packed/unpacked SV aggregates, malformed SDF variants, and full package interaction on multiple Linux distributions still require a larger release corpus.
- The synthetic layout and cached value-query targets pass, but complete Tauri-to-screen selection/cursor latency and representative customer traces remain release benchmarks. A large synthetic trace is not a substitute for representative customer traces.

The complete accepted plan's final release criteria therefore remain broader than this preview's measured qualification. Subsequent work should use the explicit milestone gates in `HDLView_IMPLEMENTATION_PLAN.md` rather than treating a successful counter demonstration as full release acceptance.

## Project Settings qualification

The browser suite includes a no-JSON project setup workflow: settings sections, simulation addition/duplication/rename/deletion, invalid DUT paths, source-import draft preservation, external model/include/SDC/SDF pickers, duplicate defines, Apply/Cancel and local preference cancellation, narrow-window footers, real counter simulation, stale-settings run blocking, and save/close/reopen with the original waveform. Run it with the documented native profile and `tools/profiles/docker.json`. Rust tests separately verify readiness versus errors, read-only reference resolution, backend SDF/physical validation, and rejecting a changed project before starting a captured simulation. Existing cross-probing, file-management and editor workflows remain release regressions.

The completed settings change passes **63 Rust tests** (53 core and 10 identity), workspace formatting and Clippy with `-D warnings`, and **32 frontend tests**, TypeScript, ESLint, formatting and production build. All **12 browser workflows pass with each provider**, native and Docker. The new workflow configures and runs the counter testbench entirely through the form, then verifies that applied simulation changes require rebuilding while retaining the original waveform. Existing small-fixture lint checks measured 1,949 ms native and 1,948 ms Docker, including debounce; these are not general project-size benchmarks.

The rebuilt Debian package passed an isolated Xvfb smoke test using actual GTK directory, SDC and project-JSON pickers. It created an empty SKY130 project, changed to IHP, configured the design top, Icarus testbench top/DUT path and clock, selected an external SDC, and exercised Apply, Escape cancellation, Save Project, Close Project and reopening. Applied settings left JSON unchanged until Save Project; reopened controls retained the saved schema-3 settings and references. The startup log was empty with the documented software-rendering compatibility environment. Evidence is `.hdlview/project-settings-desktop-results.json` and `/tmp/hdlview-settings-desktop-smoke/` screenshots/logs. This qualifies these interactions on the current host, not every Linux desktop. No full physical flow was rerun solely for the form redesign.
