`default_nettype none

module comparator_N # (
    parameter int N = 8
  ) (
  input  [N-1:0] a_i,
  input  [N-1:0] b_i,
  output         less_o,
  output         equal_o,
  output         greater_o
);

  // Flip the sign bit (MSB) of both operands
  localparam logic [N-1:0] MSB_MASK = {1'b1, {(N-1){1'b0}}};
  logic [N-1:0] a_inv_w, b_inv_w;

  logic [N:0] less_w;
  logic [N:0] equal_w;
  logic [N:0] greater_w;

  for (genvar i = 0; i < N; i++) begin: gen_full_adders
    comparator i_comparator (
      .a_i       (a_inv_w[N-1-i]    ),
      .b_i       (b_inv_w[N-1-i]    ),
      .less_i    (less_w[i]     ),
      .equal_i   (equal_w[i]    ),
      .greater_i (greater_w[i]  ),
      .less_o    (less_w[i+1]   ),
      .equal_o   (equal_w[i+1]  ),
      .greater_o (greater_w[i+1])
    );
  end

  assign a_inv_w = a_i ^ MSB_MASK;
  assign b_inv_w = b_i ^ MSB_MASK;
  assign less_w[0]    = 1'b0;
  assign equal_w[0]   = 1'b1;
  assign greater_w[0] = 1'b0;
  assign less_o       = less_w[N];
  assign equal_o      = equal_w[N];
  assign greater_o    = greater_w[N];

endmodule
`default_nettype wire
