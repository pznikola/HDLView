`timescale 1ns/100ps

`ifndef N
  `define N 8
`endif
`define MAX_RANGE ((1 << `N) - 1)
`define MAX_DATA  100

module bin2gray_tb ();

  // signals
  logic [`N-1:0] bin_i;
  logic [`N-1:0] gray_o;
  // gold data
  logic [`N-1:0] gold_w;

  bin2gray #(.N (`N)) i_bin2gray (
    .bin_i(bin_i),
    .gray_o(gray_o)
  );

  // Gold model - TODO: Think how to do this better
  assign gold_w = (bin_i>>1) ^ bin_i;

 initial begin
    for (int i = 0; i < `MAX_RANGE; i++) begin
      /* verilator lint_off WIDTHTRUNC */
      bin_i = i;
      #2;
    end
    for (int i = `MAX_RANGE; i >= 0; i--) begin
      bin_i = i;
      #2;
    end
    for (int i = 0; i <= `MAX_DATA; i++) begin
      bin_i = $urandom_range(0, `MAX_RANGE);
      /* verilator lint_on WIDTHTRUNC */
      #2;
    end
    #2
    $finish;
  end

  // Check result
  always @(gray_o) begin
    #0.1
      if (gray_o === gold_w) begin
        $display("%03d [ns]: [PASSED]: bin_i (bin: %b), gray_o (bin: %b) == expected (bin: %b)", $time, bin_i, gray_o, gold_w);
      end else begin
        $error("%03d [ns]: [FAILED]: bin_i (bin: %b), gray_o (bin: %b) != expected (bin: %b)", $time, bin_i, gray_o, gold_w);
      end
    end
endmodule
