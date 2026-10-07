`default_nettype none

module mux 
  # (
    parameter int N = 8
  ) (
  input          sel_i,
  input  [N-1:0] a_i,
  input  [N-1:0] b_i,
  output [N-1:0] c_o
);

  assign c_o = sel_i ? a_i : b_i; 

endmodule

`default_nettype wire
