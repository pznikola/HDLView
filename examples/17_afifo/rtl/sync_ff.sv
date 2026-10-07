`default_nettype none

module sync_ff #(
  parameter N = 8
) (
  input  logic [N-1:0] wr_data_i,
  input  logic         rd_clk_i,
  input  logic         rd_rst_ni,
  output logic [N-1:0] rd_data_o
);
  reg [N-1:0] data_r;

  always_ff @(posedge rd_clk_i or negedge rd_rst_ni)
    if (!rd_rst_ni) begin
      {rd_data_o, data_r} <= 0;
    end
    else begin
      {rd_data_o, data_r} <= {data_r, wr_data_i};
    end
  
endmodule
`default_nettype wire
