`timescale 1ns/100ps

`ifndef N
  `define N 8
`endif
`define MAX_RANGE ((1 << `N) - 1)
`define MAX_DATA 100

module add_sub_N_tb ();
  
  // signals
  logic signed [`N-1:0] a_i;
  logic signed [`N-1:0] b_i;
  logic ctrl_i;
  logic signed [`N-1:0] result_o;
  logic overflow_o;
  logic signed [`N-1:0] golden_sum;
  logic gold_overflow;

  add_sub_N #(.N (`N)) i_add_sub_N (
    .a_i(a_i),
    .b_i(b_i),
    .ctrl_i(ctrl_i),
    .result_o(result_o),
    .overflow_o(overflow_o)
  );

  function automatic bit gold_overflow_ext (input logic signed [`N-1:0] a, input logic signed [`N-1:0] b, input logic ctrl);
    /* verilator lint_off UNUSEDSIGNAL */
    logic signed [`N:0] result_extended;
    
    if (ctrl) result_extended = $signed({a[`N-1], a}) - $signed({b[`N-1], b});
    else      result_extended = $signed({a[`N-1], a}) + $signed({b[`N-1], b});

    return result_extended[`N] ^ result_extended[`N-1];
    /* verilator lint_on UNUSEDSIGNAL */
  endfunction

  initial begin
    for (int i = 0; i < `MAX_DATA; i++) begin
      a_i    = `N'($urandom_range(0, `MAX_RANGE));
      b_i    = `N'($urandom_range(0, `MAX_RANGE));
      ctrl_i =  1'($urandom_range(0, 1));
      #2;
    end
    #2
    $finish;
  end

  assign golden_sum = ctrl_i ? a_i - b_i : a_i + b_i;
  assign gold_overflow = gold_overflow_ext (a_i, b_i, ctrl_i);

  // Check the results
  always @(result_o or overflow_o) begin
    #0.1
    if (ctrl_i) begin
      if (overflow_o === gold_overflow && result_o === golden_sum) begin
        $display("%03d [ns]: [PASSED]: a_i - b_i = %d - %d = [overflow_o, result_o] (%d,%d) == expected (%d,%d)", $time, a_i, b_i, overflow_o, result_o, gold_overflow, golden_sum);
      end 
      else begin
        $error("%03d [ns]: [FAILED]: a_i - b_i = %d - %d = [overflow_o, result_o] (%d,%d) == expected (%d,%d)", $time, a_i, b_i, overflow_o, result_o, gold_overflow, golden_sum);
      end
    end 
    else begin
      if (overflow_o === gold_overflow && result_o === golden_sum) begin
        $display("%03d [ns]: [PASSED]: a_i + b_i = %d + %d = [overflow_o, result_o] (%d,%d) == expected (%d,%d)", $time, a_i, b_i, overflow_o, result_o, gold_overflow, golden_sum);
      end 
      else begin
        $error("%03d [ns]: [FAILED]: a_i + b_i = %d + %d = [overflow_o, result_o] (%d,%d) == expected (%d,%d)", $time, a_i, b_i, overflow_o, result_o, gold_overflow, golden_sum);
      end
    end
  end
endmodule
