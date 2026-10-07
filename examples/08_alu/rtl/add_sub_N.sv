`default_nettype none

module add_sub_N # (
    parameter int N = 8
  ) (
  input  [N-1:0] a_i,
  input  [N-1:0] b_i,
  input          ctrl_i,
  output [N-1:0] result_o,
  output         overflow_o
);

  logic [N-1:0] w_b_inv;
  logic [N-1:0] w_b_mux;
  logic         w_carry;

    adder_N i_adder_N (
      .a_i(a_i),
      .b_i(w_b_mux),
      .c_i(ctrl_i),
      .sum_o(result_o),
      .overflow_o(w_carry)
    );

  assign w_b_inv = ~b_i;
  assign w_b_mux = ctrl_i ? w_b_inv : b_i;
  assign overflow_o = w_carry;
endmodule
`default_nettype wire
