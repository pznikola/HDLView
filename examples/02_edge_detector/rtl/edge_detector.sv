`default_nettype none

module edge_detector (
  input  logic clk_i,
  input  logic rst_ni,
  input  logic data_i,
  output logic rising_edge_o,
  output logic falling_edge_o,
  output logic both_edges_o
);

  logic r_data;

  always_ff @(posedge(clk_i) or negedge(rst_ni)) begin: gen_ff
    if (!rst_ni) r_data <= 1'b0;
    else         r_data <= data_i;
  end

  // Delayed signal is 0 input is 1
  assign rising_edge_o = ~r_data & data_i;
  // Delayed signal is 1 input is 0
  assign falling_edge_o = r_data & ~data_i;
  // Delayed and input signal are different
  assign both_edges_o = r_data ^ data_i;

endmodule
`default_nettype wire
