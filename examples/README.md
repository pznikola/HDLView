# SystemVerilog examples

These 18 projects contain the RTL and testbenches from SystemVerilogExercises,
preserving each exercise's `rtl/` and `dv/` directories. Generated files and the
original Makefile workflow are not included.

Choose **File → Open Existing Project…** and select an exercise's
`hdlview.project.json`. Select **Source RTL** or **Elaborated RTL**, build the
schematic, then run the **rtl** simulation configuration. The design top,
testbench top, DUT scope, parameters and defines are already configured.

| Project                                                                                     | Demonstrates                                             |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| [00_mux](00_mux/hdlview.project.json)                                                       | Parameterized multiplexer                                |
| [01_simpleRegister](01_simpleRegister/hdlview.project.json)                                 | Register with asynchronous reset                         |
| [02_edge_detector](02_edge_detector/hdlview.project.json)                                   | Rising and falling edge detection                        |
| [03_full_adder](03_full_adder/hdlview.project.json)                                         | Single-bit full adder                                    |
| [04_adder_N](04_adder_N/hdlview.project.json)                                               | Parameterized ripple-carry adder                         |
| [05_add_sub_N](05_add_sub_N/hdlview.project.json)                                           | Hierarchical addition and subtraction                    |
| [06_comparator](06_comparator/hdlview.project.json)                                         | Single-bit comparison                                    |
| [07_comparator_N](07_comparator_N/hdlview.project.json)                                     | Parameterized comparison                                 |
| [08_alu](08_alu/hdlview.project.json)                                                       | Arithmetic, logic, shifts and a shared operation package |
| [09_shift_register](09_shift_register/hdlview.project.json)                                 | Shift register                                           |
| [10_linear_feedback_shift_register](10_linear_feedback_shift_register/hdlview.project.json) | Linear-feedback shift register                           |
| [11_fifo](11_fifo/hdlview.project.json)                                                     | Synchronous FIFO                                         |
| [12_bin2onehot](12_bin2onehot/hdlview.project.json)                                         | Binary-to-one-hot conversion                             |
| [13_bin2gray](13_bin2gray/hdlview.project.json)                                             | Binary-to-Gray conversion                                |
| [14_gray2bin](14_gray2bin/hdlview.project.json)                                             | Gray-to-binary conversion                                |
| [15_sync_ff](15_sync_ff/hdlview.project.json)                                               | Two-stage synchronizer                                   |
| [16_mem](16_mem/hdlview.project.json)                                                       | Parameterized memory                                     |
| [17_afifo](17_afifo/hdlview.project.json)                                                   | Asynchronous FIFO with separate clocks                   |

All projects use schema 3, SystemVerilog `1800-2017`, SKY130 as the initial
technology, and Icarus with a 2 µs simulation limit. Testbenches normally finish
earlier; the limit accommodates the ALU and asynchronous FIFO. Parameters and
simulation defines match the original Makefile defaults. The ALU package is
listed before its consumers.

Tool paths come from your Toolchain settings. Physical constraints are deliberately
unset: configure clocks and physical settings before mapped or post-layout builds.
Gate simulation may require adjusting testbench DUT parameter overrides; do not
assume every exercise testbench is suitable for an exported gate netlist.

Source RTL currently reports opaque generate-instance arrays and memory aggregates
in some exercises. Use Elaborated RTL for their resolved circuitry. Compiler-only
signals and unsupported generated hierarchy mappings remain unavailable in the
waveform; public DUT ports bind normally.

The only HDL change is in `15_sync_ff/dv/sync_ff_tb.sv`: its expected-value queue
starts with zero so the first read checks the reset output instead of popping an
empty queue before the first write. The assertion and subsequent data checks
remain enabled. All other RTL and testbench files are unchanged.

The former counter, Verilog range and schematic showcase examples now live in
`tests/fixtures/`, where browser and toolchain regression tests continue to use them.
