`default_nettype none

module adder_N # (
    parameter int N = 8
  ) (
  input  [N-1:0] a_i,
  input  [N-1:0] b_i,
  input          c_i,
  output [N-1:0] sum_o,
  output         overflow_o
);

  logic [N:0] w_carry;

  for (genvar i = 0; i < N; i++) begin: gen_full_adders
    full_adder i_full_adder (
      .a_i(a_i[i]),
      .b_i(b_i[i]),
      .c_i(w_carry[i]),
      .sum_o(sum_o[i]),
      .c_o(w_carry[i+1])
    );
  end

  assign w_carry[0] = c_i;
  assign overflow_o = w_carry[N] ^ w_carry[N-1];

endmodule
`default_nettype wire
