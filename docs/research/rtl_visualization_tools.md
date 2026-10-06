# Open-Source RTL & Netlist Visualization Tools

A compact reference for AI agents evaluating software for RTL, synthesized-netlist, and digital-circuit visualization.

## Core Tools

### Yosys

- **Purpose:** Open-source RTL synthesis and elaboration framework.
- **Input:** Verilog/SystemVerilog; VHDL via GHDL integration.
- **Output:** RTLIL, synthesized netlists, Verilog, JSON, Graphviz-based schematics.
- **Why useful:** Best synthesis/backend foundation for a custom RTL visualizer. `write_json` is especially useful for feeding a custom schematic renderer.
- **Role in our project:** Primary frontend/backend for elaboration, synthesis, optimization, and technology mapping.

### NetlistSVG

- **Purpose:** Converts Yosys JSON netlists into SVG schematics.
- **Input:** Yosys JSON.
- **Output:** SVG circuit diagrams.
- **Why useful:** Excellent reference implementation for turning Yosys data into readable schematics. Uses ELK for layout and supports custom visual skins.
- **Role in our project:** Good first prototype renderer or reference for building a custom renderer.

### DigitalJS / yosys2digitaljs

- **Purpose:** Interactive digital circuit visualization and simulation, aimed partly at education.
- **Input:** Yosys-derived circuit data.
- **Output:** Interactive circuit view and simulation.
- **Why useful:** Strong example of how RTL can become an interactive teaching tool rather than a static schematic.
- **Role in our project:** Reference for simulation, interactivity, and student-friendly visualization.

### FEntwumS.NetlistViewer

- **Purpose:** Interactive hierarchical HDL/netlist viewer.
- **Input:** Yosys JSON generated from HDL or post-synthesis netlists.
- **Output:** Navigable hierarchical schematic.
- **Key features:** Expand/collapse hierarchy, pan/zoom, source navigation, post-synthesis viewing.
- **Why useful:** One of the closest existing projects to the intended application.

### VeriSim

- **Purpose:** Browser-based Verilog IDE with simulation and synthesis visualization.
- **Input:** Verilog.
- **Output:** RTL-level and gate-level schematic views.
- **Why useful:** Demonstrates separate educational views for RTL operators such as muxes/adders/registers and synthesized gate-level logic.

### TerosHDL

- **Purpose:** HDL development environment and VS Code extension.
- **Input:** Verilog, SystemVerilog, VHDL.
- **Output:** HDL tooling plus schematic visualization.
- **Why useful:** Mature example of integrating source code, HDL analysis, and schematic viewing in a developer UI.

### CircuitVerse

- **Purpose:** Educational digital logic design and simulation platform.
- **Input:** Graphical circuits and Verilog-based synthesis workflows.
- **Output:** Interactive circuits and simulations.
- **Why useful:** Strong reference for educational UX and for converting synthesized HDL into interactive digital circuits.

### HAL

- **Purpose:** Hardware netlist analysis framework.
- **Input:** Gate-level structural netlists.
- **Output:** Interactive gate/netlist exploration and analysis.
- **Key features:** Hierarchy, fan-in/fan-out analysis, cone exploration, Python scripting.
- **Why useful:** Excellent reference for large post-synthesis or gate-level netlist visualization.
- **Limitation:** Not intended primarily for behavioral RTL visualization.

### OpenCircuitX

- **Purpose:** Open-source EDA environment with RTL visualization features.
- **Input:** Primarily VHDL in its current RTL visualization flow.
- **Output:** Interactive circuit/schematic view.
- **Why useful:** Useful UI reference for routing, fanout highlighting, zoom/pan, and direct RTL visualization.

### Verilog-IDE

- **Purpose:** Lightweight Verilog development environment.
- **Pipeline:** Verilog -> Yosys -> JSON -> NetlistSVG.
- **Why useful:** Simple reference architecture showing how the major open-source components can be connected.

### Sphinx HDL Diagrams

- **Purpose:** Generate HDL schematics for documentation.
- **Input:** HDL processed through Yosys.
- **Output:** Static SVG/diagram documentation.
- **Why useful:** Good reference for automated documentation pipelines and multiple abstraction levels.

### YosysJS-netlistviewer

- **Purpose:** Browser-based experimental Yosys netlist viewer.
- **Input:** Yosys/YosysJS output.
- **Output:** Browser-rendered schematic.
- **Why useful:** Historical proof of concept for fully browser-side synthesis/visualization.
- **Limitation:** Older project; better used as a reference than as a new foundation.

### Pyverilog

- **Purpose:** Python toolkit for Verilog parsing, dataflow analysis, and control-flow analysis.
- **Input:** Verilog.
- **Output:** Parsed AST/dataflow/control-flow structures and Graphviz visualizations.
- **Why useful:** Good option for pedagogical dataflow or control-flow views that differ from a conventional hardware schematic.

### Chisel/FIRRTL Diagrammer

- **Purpose:** Generate diagrams from Chisel/FIRRTL hardware descriptions.
- **Input:** FIRRTL/Chisel-related representations.
- **Output:** Graphviz/SVG hierarchy and circuit diagrams.
- **Why useful:** Useful architectural/UI reference, but not directly targeted at normal Verilog/VHDL workflows.

## Supporting Components

### GHDL

- **Purpose:** VHDL compiler, simulator, and synthesis frontend.
- **Input:** VHDL.
- **Output:** Synthesized representations, including Graphviz DOT and forms usable with Yosys.
- **Role in our project:** Recommended VHDL frontend.

### ghdl-yosys-plugin

- **Purpose:** Connects GHDL to Yosys.
- **Role in our project:** Allows VHDL to enter the same Yosys-based visualization pipeline as Verilog/SystemVerilog.

### ELK / elkjs

- **Purpose:** Automatic graph layout engine.
- **Input:** Nodes, ports, edges, hierarchy.
- **Output:** Node coordinates and routed edges.
- **Why useful:** Very well suited to digital schematics with directed signal flow and explicit ports.
- **Role in our project:** Recommended layout engine for a custom renderer.

### d3-hwschematic

- **Purpose:** Interactive hierarchical hardware schematic rendering.
- **Input:** Structured hardware graph data.
- **Output:** Expandable, zoomable, interactive schematics.
- **Why useful:** Supports hierarchy, selection, custom rendering, and ELK-based layout.
- **Role in our project:** Strong alternative/reference for the custom frontend renderer.

### Graphviz

- **Purpose:** General graph layout and rendering.
- **Input:** DOT graphs.
- **Output:** SVG, PNG, PDF, etc.
- **Why useful:** Excellent for prototypes and static output.
- **Limitation:** Less suitable than ELK/custom SVG for a highly interactive educational application.

## Source-Available / Licensing-Caution References

### sv-pathfinder

- **Purpose:** Modern SystemVerilog navigation and schematic viewing.
- **Useful ideas:** RTL/gate-level views, hierarchy navigation, source cross-probing, waveform integration.
- **Caution:** Public source, but licensing is more restrictive than conventional OSI open source.

### AURORA / PRISM

- **Purpose:** HDL tooling using Yosys, NetlistSVG, and DigitalJS-style components.
- **Why useful:** Good architecture reference for synthesis + visualization + simulation.
- **Caution:** Custom license restricts some commercial use.

### NetCrux

- **Purpose:** Hierarchical RTL/netlist exploration.
- **Useful ideas:** Fan-in/fan-out tracing, cone extraction, hierarchy, search, highlighting.
- **Caution:** Verify current source availability and license before reuse.

### RTL Bench

- **Purpose:** RTL/netlist visualization UI.
- **Useful ideas:** Hierarchical/flat views, bus collapsing, click-to-trace, ELK routing.
- **Caution:** Frontend is open source, but synthesis/backend components are not fully open.

### RapidRTL

- **Purpose:** HDL-to-interactive-schematic product.
- **Useful ideas:** Closely matches the desired user experience.
- **Caution:** Treat mainly as a product/UX reference unless full open-source availability is confirmed.

## Recommended Architecture

Recommended visualization modes:

1. **Hierarchy view** — modules and instances.
2. **RTL schematic** — muxes, adders, comparators, registers, memories, buses.
3. **Synthesized schematic** — generic gates, FPGA LUTs/carry cells, or ASIC standard cells.

## Best Projects to Study First

1. **Yosys** — synthesis and JSON export.
2. **NetlistSVG** — Yosys JSON to schematic rendering.
3. **DigitalJS / yosys2digitaljs** — interactive educational circuit visualization.
4. **FEntwumS.NetlistViewer** — hierarchy and post-synthesis navigation.
5. **VeriSim** — separate RTL and gate-level views.
6. **ELK / elkjs** — automatic schematic layout.

## Inspected reference checkouts

These revisions record the local research inputs used during development.
The checkouts are not vendored application dependencies and are not needed
for builds, tests, or runtime operation. Consult the upstream license before
reusing source; HDLView dependencies and notices are documented separately.

| Upstream repository                                                                   | Inspected commit                           |
| ------------------------------------------------------------------------------------- | ------------------------------------------ |
| [CircuitVerse](https://github.com/CircuitVerse/CircuitVerse)                          | `6f725c5a924dc0b73527215eb5aa0618e45330e1` |
| [FEntwumS.NetlistViewer](https://github.com/FEntwumS/FEntwumS.NetlistViewer)          | `bcd4bc1bc8809d8aa5c4e0a509798746b34d0a48` |
| [OpenCircuitX](https://github.com/openlab-x/OpenCircuitX)                             | `96343c08a3cfd03ccf39073b74547af662e27c1c` |
| [Pyverilog](https://github.com/PyHDI/Pyverilog)                                       | `81838bc463d17148ef6872af34eb27585ee349ba` |
| [TerosHDLbackend](https://github.com/TerosTechnology/TerosHDLbackend)                 | `e75dc14031df065dbdbde3bbc961c28ac34dd00a` |
| [Verilog-IDE](https://github.com/snwizard/Verilog-IDE)                                | `237a06b4602fc6a8e930471a1dff3bcec3cd8c8d` |
| [YosysJS-netlistviewer](https://github.com/karthikeyann/YosysJS-netlistviewer)        | `6f2dab4004b81a62c9824b4afd6c8dc31b0ac38c` |
| [aurora](https://github.com/nipscernlab/aurora)                                       | `b4d481447b9e18184f0fd76a11fabe08eba9b8f7` |
| [d3-hwschematic](https://github.com/Nic30/d3-hwschematic)                             | `0664665d87d7fe8575a812714b765a81de1affbf` |
| [diagrammer](https://github.com/freechipsproject/diagrammer)                          | `454670839f500d23301575b7e36730ddc213a79b` |
| [digitaljs](https://github.com/tilk/digitaljs)                                        | `a77a6b3a916996e215e6c33c75ffe05dc6f55e3d` |
| [elk](https://github.com/eclipse-elk/elk)                                             | `8aaa3c145c2a18a38aabbc725aa3791ddc517a76` |
| [elkjs](https://github.com/kieler/elkjs)                                              | `722f1a3f63016e64f534a8b445283d4d31a88d0e` |
| [ghdl](https://github.com/ghdl/ghdl)                                                  | `4919fc2cad7b045a166861d5cec345d06429a6d7` |
| [ghdl-yosys-plugin](https://github.com/ghdl/ghdl-yosys-plugin)                        | `5ec8c1921670588bd8bab4fa664b6f72ecb84016` |
| [graphviz](https://gitlab.com/graphviz/graphviz)                                      | `7fe230c03fa43e1169653d9d00931b6fc44e6142` |
| [hal](https://github.com/emsec/hal)                                                   | `7151a1b7d766a66b7e59a2118a1f15fa583bb49f` |
| [netlistsvg](https://github.com/nturley/netlistsvg)                                   | `d3518f1b5c996a876b72a1a984bb39d3572c47dc` |
| [rtlbench](https://github.com/Raghavan-04/rtlbench)                                   | `08cc57f15b95c22279ea4427642a058c03335294` |
| [sphinxcontrib-hdl-diagrams](https://github.com/SymbiFlow/sphinxcontrib-hdl-diagrams) | `5166ade92cb855d87c34fd713b8f489e7dd04561` |
| [sv-pathfinder](https://github.com/heyfey/sv-pathfinder)                              | `af18e07a3ce01559619619bff14363177faa5f2b` |
| [verisim](https://github.com/senolgulgonul/verisim)                                   | `a275a9ac28c59db1130505973644c9a3754ec1d7` |
| [vscode-terosHDL](https://github.com/TerosTechnology/vscode-terosHDL)                 | `ee15cd783e34b7a291928e98e6685fd4a5db7cd7` |
| [yosys](https://github.com/YosysHQ/yosys)                                             | `0e8336b4e2659efb40c2b8751c7619f69c358137` |
| [yosys2digitaljs](https://github.com/tilk/yosys2digitaljs)                            | `1cb9ab90207a72eb9786ace8cd562baeca1262bc` |
