# Dependencies and attribution

Application dependencies are resolved by committed `Cargo.lock` and `package-lock.json`; use locked/clean installs. No source from the supplied reference repositories was copied into HDLView. Generated graph/model data is produced by external tools.

| Dependency          | Pin                                                                                                       | License / source                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Tauri               | Rust, JS API, and CLI 2.12.1                                                                              | MIT OR Apache-2.0 — https://github.com/tauri-apps/tauri             |
| Tauri dialog plugin | Rust and JS 2.8.1                                                                                         | MIT OR Apache-2.0 — https://github.com/tauri-apps/plugins-workspace |
| CodeMirror          | view 6.43.13, state 6.7.6, commands 6.11.1, search 6.7.2, language 6.12.4, legacy-modes 6.5.4, lint 6.9.5 | MIT — https://codemirror.net/                                       |
| Lezer highlighting  | 1.2.5                                                                                                     | MIT — https://github.com/lezer-parser/highlight                     |
| React / React DOM   | 19.1.1                                                                                                    | MIT — https://github.com/facebook/react                             |
| Vite                | 7.3.6                                                                                                     | MIT — https://github.com/vitejs/vite                                |
| TypeScript          | 5.9.2                                                                                                     | Apache-2.0 — https://github.com/microsoft/TypeScript                |
| elkjs               | 0.11.0                                                                                                    | EPL-2.0 — https://github.com/kieler/elkjs/tree/0.11.0               |
| Wellen              | 0.25.6                                                                                                    | BSD-3-Clause — https://github.com/ekiwi/wellen                      |
| Vitest              | 4.1.11                                                                                                    | MIT — https://github.com/vitest-dev/vitest                          |
| Playwright          | 1.55.1                                                                                                    | Apache-2.0 — https://github.com/microsoft/playwright                |
| Prettier            | 3.6.2                                                                                                     | MIT — https://github.com/prettier/prettier                          |

ELK's generated worker is copied **unmodified** from the installed pinned package into the application bundle. Its copyright/license headers are retained. Its corresponding source is available from the linked release; include its EPL notice/source availability when redistributing. `tools/frontend-assets.mjs` copies the installed license text when supplied by the package.

## External toolchain

The tools and PDKs run outside the application process, either natively or in Docker. They retain their own licenses and redistribution obligations. The base image is pinned to:

```
hpretl/iic-osic-tools@sha256:92961478ad3c4f508efb42d9ccdba12ab262eb42a14926d2bd49862230ba8521
```

See the image's [upstream source and notices](https://github.com/iic-jku/IIC-OSIC-TOOLS). The derived Dockerfile pins pyslang 10.0.0, LibreLane 3.0.0, and the Magic source commit. pyslang 10 provides the Verilog-2005 language version absent from the previously pinned 9.1 binding; its source/model helper APIs were requalified. See [the pyslang release](https://pypi.org/project/pyslang/10.0.0/) and [Slang language-version options](https://www.sv-lang.com/command-line-ref.html). Yosys is ISC-licensed, Slang/pyslang 10.0.0 use MIT (verified from the installed wheel); LibreLane uses Apache-2.0, and Icarus is GPL-licensed; verify the exact release notices when redistributing the image. The upstream image may contain unused tools, including GHDL; HDLView does not configure or invoke them. Retain the image’s notices when redistributing it. Wellen and CodeMirror packages also retain bundled readers/modes that HDLView does not expose. Do not infer that all tools in the image share a permissive license.

Live style checks invoke the base image's Verible `v0.0-3724-gdec56671`, fixed by the image digest. Verible uses Apache-2.0, with separately attributed third-party files; retain its release notices when redistributing the tool image. See [that revision](https://github.com/chipsalliance/verible/tree/dec56671f8aa63a77b687b4df9753de451582b53) and [its licensing](https://github.com/chipsalliance/verible/blob/dec56671f8aa63a77b687b4df9753de451582b53/LICENSE). CodeMirror lint's installed MIT license is included in the generated application notices.

Primary project sources:

- https://github.com/YosysHQ/yosys
- https://github.com/povik/sv-elab
- https://github.com/MikePopoloski/slang
- https://github.com/steveicarus/iverilog
- https://github.com/verilator/verilator
- https://github.com/chipsalliance/verible
- https://github.com/librelane/librelane
- https://github.com/RTimothyEdwards/magic
- https://github.com/google/skywater-pdk
- https://github.com/IHP-GmbH/IHP-Open-PDK

Reference repositories such as NetlistSVG, d3-hwschematic, DigitalJS, TerosHDL, HAL, and waveform viewers informed the architecture. They are not runtime dependencies. Repositories with restrictive or unclear terms remain references only.
