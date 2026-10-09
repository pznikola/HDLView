`timescale 1ns/100ps

`ifndef N
  `define N 8
`endif
`define MAX_RANGE ((1 << `N) - 1)

module mux_tb ();

  logic          sel_i;
  logic [`N-1:0] a_i;
  logic [`N-1:0] b_i;
  logic [`N-1:0] c_o;

  mux #(.N (`N)) i_mux (
    .a_i(a_i),
    .b_i(b_i),
    .sel_i(sel_i),
    .c_o(c_o)
  );

  initial begin
    for (int i = 0; i < 40; i++) begin
      /* verilator lint_off WIDTHTRUNC */
      a_i   = $urandom_range(0, `MAX_RANGE);
      b_i   = $urandom_range(0, `MAX_RANGE);
      sel_i = $urandom_range(0, 1);
      /* verilator lint_on WIDTHTRUNC */
      #2;
    end
    #10 
    $finish;
  end

  // Check the results
  always @(c_o) begin
    if (sel_i) begin: gen_expect_a
      if (c_o === a_i) begin
        $display("%02d [ns]: [PASSED]: c_o (hex: %02H) == a_i (hex: %02H) when sel_i=1", $time, c_o, a_i);
      end else begin
        $error("%02d [ns]: [FAILED]: c_o (hex: %02H) != a_i (hex: %02H) when sel_i=1", $time, c_o, a_i);
      end
    end
    else begin: gen_expect_b
      if (c_o === b_i) begin
        $display("%02d [ns]: [PASSED]: c_o (hex: %02H) == b_i (hex: %02H) when sel_i=0", $time, c_o, a_i);
      end else begin
        $error("%02d [ns]: [FAILED]: c_o (hex: %02H) != b_i (hex: %02H) when sel_i=0", $time, c_o, a_i);
      end
    end
  end
endmodule
