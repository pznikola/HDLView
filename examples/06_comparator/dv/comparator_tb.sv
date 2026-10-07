`timescale 1ns/100ps

`define MAX_DATA 50

module comparator_tb ();
  
  // signals
  logic a_i;
  logic b_i;
  logic less_i;
  logic equal_i;
  logic greater_i;
  logic less_o;
  logic equal_o;
  logic greater_o;
  logic w_less;
  logic w_equal;
  logic w_greater;

  comparator i_comparator (
    .a_i      (a_i      ),
    .b_i      (b_i      ),
    .less_i   (less_i   ),
    .equal_i  (equal_i  ),
    .greater_i(greater_i),
    .less_o   (less_o   ),
    .equal_o  (equal_o  ),
    .greater_o(greater_o)
  );

  // Dump *.vcd and check if enough data was send, and if so terminate test
	initial begin
    $dumpfile("comparator.vcd");
    $dumpvars(0, comparator_tb);
	end

  initial begin
    for (int i = 0; i < `MAX_DATA; i++) begin
      /* verilator lint_off WIDTHTRUNC */
      a_i       = $urandom_range(0, 1);
      b_i       = $urandom_range(0, 1);
      less_i    = $urandom_range(0, 1);
      equal_i   = $urandom_range(0, 1);
      if(less_i) greater_i = 1'b0;
      else       greater_i = $urandom_range(0, 1);
      /* verilator lint_on WIDTHTRUNC */
      #2;
    end
    #2
    $finish;
  end
  assign w_equal   = !(a_i ^ b_i) & equal_i;
  assign w_less    = !a_i & b_i & equal_i | less_i;
  assign w_greater = a_i & !b_i & equal_i | greater_i;

  // Check the results
  always @(*) begin
    #0.1
    if (less_o == w_less && greater_o == w_greater && equal_o == w_equal) begin
      $display("%02d [ns]: [PASSED]: For input: a_i, b_i (%b, %b), less_i, equal_i, greater_i (%b, %b, %b) , output: less_o, equal_o, greater_o (%b, %b, %b) == expected (%b, %b, %b)", $time, a_i, b_i, less_i, equal_i, greater_i, less_o, equal_o, greater_o, w_less, w_equal, w_greater);
    end else begin
      $error("%02d [ns]: [FAILED]: For input: a_i, b_i (%b, %b), less_i, equal_i, greater_i (%b, %b, %b) , output: less_o, equal_o, greater_o (%b, %b, %b) != expected (%b, %b, %b)", $time, a_i, b_i, less_i, equal_i, greater_i, less_o, equal_o, greater_o, w_less, w_equal, w_greater);
    end
  end
endmodule
