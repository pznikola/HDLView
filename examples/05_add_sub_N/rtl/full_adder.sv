`default_nettype none

module full_adder (
  input  a_i,
  input  b_i,
  input  c_i,
  output sum_o,
  output c_o
);

  assign sum_o = a_i ^ b_i ^ c_i;
  assign c_o = (a_i & b_i) | ((a_i ^ b_i) & c_i);

endmodule
`default_nettype wire
