`default_nettype none

module bin2onehot #(
  parameter N = 8,
  localparam int ONEHOT_N = (1 << N)
)(
  input  logic [       N-1:0] bin_i,
  output logic [ONEHOT_N-1:0] onehot_o
);

  assign onehot_o = 1'b1 << bin_i;

endmodule
`default_nettype wire
