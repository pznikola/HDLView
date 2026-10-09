`timescale 1ns/100ps

`ifndef N
  `define N 8
`endif
`define MAX_RANGE ((1 << `N) - 1)
`define MAX_DATA 50

module comparator_N_tb ();
  
  // signals
  logic signed [`N-1:0] a_i;
  logic signed [`N-1:0] b_i;
  logic          less_o;
  logic          equal_o;
  logic          greater_o;
  logic          less_w;
  logic          equal_w;
  logic          greater_w;

  comparator_N #(.N (`N)) i_comparator_N (
    .a_i       (a_i),
    .b_i       (b_i),
    .less_o    (less_o),
    .equal_o   (equal_o),
    .greater_o (greater_o)
  );

  initial begin
    for (int i = 0; i < `MAX_DATA; i++) begin
      if (i % 8 == 0) begin
        a_i = `N'($urandom_range(0, `MAX_RANGE));
        b_i = a_i;
      end
      else begin
        a_i = `N'($urandom_range(0, `MAX_RANGE));
        b_i = `N'($urandom_range(0, `MAX_RANGE));
      end
      #2;
    end
    $finish;
  end

  assign less_w    = a_i < b_i;
  assign equal_w   = a_i == b_i;
  assign greater_w = a_i > b_i;

  // Check the results
  always @(*) begin
    #0.1
    if (less_o === less_w && equal_o === equal_w && greater_o === greater_w) begin
      $display("%02d [ns]: [PASSED]: a_i = %d, b_i = %d, [less_o, equal_o, greater_o] (%b, %b, %b) == expected (%b, %b, %b)", $time, a_i, b_i, less_o, equal_o, greater_o, less_w, equal_w, greater_w);
    end else begin
      $error("%02d [ns]: [FAILED]: a_i = %d, b_i = %d, [less_o, equal_o, greater_o] (%b, %b, %b) != expected (%b, %b, %b)", $time, a_i, b_i, less_o, equal_o, greater_o, less_w, equal_w, greater_w);
    end
  end
endmodule
