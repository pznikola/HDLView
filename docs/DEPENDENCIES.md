# Dependencies and attribution

Application dependencies are resolved by committed `Cargo.lock` and `package-lock.json`; use locked/clean installs. No source from the supplied reference repositories was copied into HDLView. Generated graph/model data is produced by external tools.

| Dependency        | Pin                                                    | License / source                                        |
| ----------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| Tauri             | 2.x, exact Rust resolution in Cargo.lock; JS API 2.8.0 | MIT OR Apache-2.0 — https://github.com/tauri-apps/tauri |
| React / React DOM | 19.1.1                                                 | MIT — https://github.com/facebook/react                 |
| Vite              | 7.3.6                                                  | MIT — https://github.com/vitejs/vite                    |
| TypeScript        | 5.9.2                                                  | Apache-2.0 — https://github.com/microsoft/TypeScript    |
| elkjs             | 0.11.0                                                 | EPL-2.0 — https://github.com/kieler/elkjs/tree/0.11.0   |
| Wellen            | 0.25.6                                                 | BSD-3-Clause — https://github.com/ekiwi/wellen          |
| Vitest            | 4.1.11                                                 | MIT — https://github.com/vitest-dev/vitest              |
| Playwright        | 1.55.1                                                 | Apache-2.0 — https://github.com/microsoft/playwright    |
| Prettier          | 3.6.2                                                  | MIT — https://github.com/prettier/prettier              |

ELK's generated worker is copied **unmodified** from the installed pinned package into the application bundle. Its copyright/license headers are retained. Its corresponding source is available from the linked release; include its EPL notice/source availability when redistributing. `tools/frontend-assets.mjs` copies the installed license text when supplied by the package.

## External toolchain

The tools and PDKs run outside the application process, either natively or in Docker. They retain their own licenses and redistribution obligations. The base image is pinned to:

```
hpretl/iic-osic-tools@sha256:92961478ad3c4f508efb42d9ccdba12ab262eb42a14926d2bd49862230ba8521
```

See the image's [upstream source and notices](https://github.com/iic-jku/IIC-OSIC-TOOLS). The derived Dockerfile pins added components and the Magic source commit. GHDL is GPL-licensed, Yosys is ISC-licensed, Slang/pyslang and LibreLane use Apache-2.0, and Icarus is GPL-licensed; verify the exact release notices when redistributing the image. Do not infer that all tools in the image share a permissive license.

Primary project sources:

- https://github.com/YosysHQ/yosys
- https://github.com/povik/sv-elab
- https://github.com/MikePopoloski/slang
- https://github.com/ghdl/ghdl
- https://github.com/ghdl/ghdl-yosys-plugin
- https://github.com/steveicarus/iverilog
- https://github.com/verilator/verilator
- https://github.com/librelane/librelane
- https://github.com/RTimothyEdwards/magic
- https://github.com/google/skywater-pdk
- https://github.com/IHP-GmbH/IHP-Open-PDK

Reference repositories such as NetlistSVG, d3-hwschematic, DigitalJS, TerosHDL, HAL, and waveform viewers informed the architecture. They are not runtime dependencies. Repositories with restrictive or unclear terms remain references only.
