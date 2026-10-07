`default_nettype none

module comparator (
  input  a_i,
  input  b_i,
  input  less_i,
  input  equal_i,
  input  greater_i,
  output less_o,
  output equal_o,
  output greater_o
);

  assign equal_o = !(a_i ^ b_i) & equal_i;
  assign less_o = !a_i & b_i & equal_i | less_i;
  assign greater_o = a_i & !b_i & equal_i | greater_i;

endmodule
`default_nettype wire
