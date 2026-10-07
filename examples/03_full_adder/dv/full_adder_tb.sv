`timescale 1ns/100ps

`define MAX_DATA 50

module full_adder_tb ();
  
  // signals
  logic a_i;
  logic b_i;
  logic c_i;
  logic sum_o;
  logic c_o;
  logic [1:0] golden_sum;

  full_adder i_full_adder (
    .a_i(a_i),
    .b_i(b_i),
    .c_i(c_i),
    .sum_o(sum_o),
    .c_o(c_o)
  );

  // Dump *.vcd and check if enough data was send, and if so terminate test
	initial begin
    $dumpfile("full_adder.vcd");
    $dumpvars(0, full_adder_tb);
	end

  initial begin
    for (int i = 0; i < `MAX_DATA; i++) begin
      /* verilator lint_off WIDTHTRUNC */
      a_i = $urandom_range(0, 1);
      b_i = $urandom_range(0, 1);
      c_i = $urandom_range(0, 1);
      /* verilator lint_on WIDTHTRUNC */
      golden_sum = a_i + b_i + c_i;
      #2;
    end
    #2
    $finish;
  end

  // Check the results
  always @(c_o or sum_o) begin
    if (c_o === golden_sum[1] && sum_o === golden_sum[0]) begin
      $display("%02d [ns]: [PASSED]: a_i + b_i + c_i = %b + %b + %b = [c_o, sum_o] (bin: %b%b) == expected (bin: %b)", $time, a_i, b_i, c_i, c_o, sum_o, golden_sum);
    end else begin
      $error("%02d [ns]: [FAILED]: a_i + b_i + c_i = %b + %b + %b = [c_o, sum_o] (bin: %b%b) != expected (bin: %b)", $time, a_i, b_i, c_i, c_o, sum_o, golden_sum);
    end
  end
endmodule
