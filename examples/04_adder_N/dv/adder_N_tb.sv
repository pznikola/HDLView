`timescale 1ns/100ps

`ifndef N
  `define N 8
`endif
`define MAX_RANGE ((1 << `N) - 1)
`define MAX_DATA 50

module adder_N_tb ();
  
  // signals
  logic signed [`N-1:0] a_i;
  logic signed [`N-1:0] b_i;
  logic c_i;
  logic signed [`N-1:0] sum_o;
  logic overflow_o;
  logic signed [`N-1:0] golden_sum;
  logic golden_c;

  adder_N #(.N (`N)) i_adder_N (
    .a_i(a_i),
    .b_i(b_i),
    .c_i(c_i),
    .sum_o(sum_o),
    .overflow_o(overflow_o)
  );

  function automatic bit gold_overflow_ext (input logic signed [`N-1:0] a, input logic signed [`N-1:0] b, input logic c);
    /* verilator lint_off UNUSEDSIGNAL */
    logic signed [`N:0] sum_ext;
    sum_ext = $signed({a[`N-1], a}) + $signed({b[`N-1], b}) + $signed({{(`N-1){1'b0}}, c});
    return sum_ext[`N] ^ sum_ext[`N-1];
    /* verilator lint_on UNUSEDSIGNAL */
  endfunction

  // Dump *.vcd and check if enough data was send, and if so terminate test
	initial begin
    $dumpfile("adder_N.vcd");
    $dumpvars(0, adder_N_tb);
	end

  initial begin
    for (int i = 0; i < `MAX_DATA; i++) begin
      a_i = `N'($urandom_range(0, `MAX_RANGE));
      b_i = `N'($urandom_range(0, `MAX_RANGE));
      c_i = 1'($urandom_range(0, 1));
      #2;
    end
    #2
    $finish;
  end

  assign golden_sum = a_i + b_i + $signed({{(`N-2){1'b0}}, c_i});
  assign golden_c = gold_overflow_ext (a_i, b_i, c_i);

  // Check the results
  always @(sum_o, overflow_o) begin
    #0.1
    if (overflow_o === golden_c && sum_o === golden_sum) begin
      $display("%02d [ns]: [PASSED]: a_i + b_i + c_i = %d + %d + %b = [overflow_o, sum_o] = [%b, %d]  == expected: [%b, %d]", $time, a_i, b_i, c_i, overflow_o, sum_o, golden_c, golden_sum);
    end else begin
      $error("%02d [ns]: [FAILED]: a_i + b_i + c_i = %d + %d + %b = [overflow_o, sum_o] = [%b, %d] != expected: [%b, %d]", $time, a_i, b_i, c_i, overflow_o, sum_o, golden_c, golden_sum);
    end
  end
endmodule
