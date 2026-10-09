`timescale 1ns/100ps

`ifndef N
  `define N 4
`endif
`define MAX_RANGE ((1 << `N) - 1)
`define MAX_DATA  100

module bin2onehot_tb ();
  // local parameters
  localparam int ONEHOT_N = (1 << `N);

  // signals
  logic [      `N-1:0] bin_i;
  logic [ONEHOT_N-1:0] onehot_o;
  // gold data
  logic [ONEHOT_N-1:0] gold_w;

  bin2onehot #(.N (`N)) i_bin2onehot (
    .bin_i(bin_i),
    .onehot_o(onehot_o)
  );

  // Gold model - TODO: Think how to do this better
  assign gold_w = 1'b1 << bin_i;

 initial begin
    for (int i = 0; i < `MAX_DATA; i++) begin
      /* verilator lint_off WIDTHTRUNC */
      bin_i = $urandom_range(0, `MAX_RANGE);
      /* verilator lint_on WIDTHTRUNC */
      #2;
    end
    #2
    $finish;
  end

  // Check result
  always @(onehot_o) begin
    #0.1
      if (onehot_o === gold_w) begin
        $display("%03d [ns]: [PASSED]: bin_i (dec: %d), onehot_o (hex: 0x%h) == expected (hex: 0x%h)", $time, bin_i, onehot_o, gold_w);
      end else begin
        $error("%03d [ns]: [FAILED]: bin_i (dec: %d), onehot_o (hex: 0x%h) != expected (hex: 0x%h)", $time, bin_i, onehot_o, gold_w);
      end
    end
endmodule
