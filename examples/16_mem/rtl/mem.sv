`default_nettype none

module mem #(
  parameter DSIZE = 8, // Memory data word width
  parameter ASIZE = 4  // Number of mem address bits
)(
  input              clk_i,
  input              wr_en_i,
  input  [DSIZE-1:0] wr_data_i,
  input  [ASIZE-1:0] wr_address_i,
  input  [ASIZE-1:0] rd_address_i,
  output [DSIZE-1:0] rd_data_o
);

  localparam DEPTH = 1 << ASIZE;
  logic [DSIZE-1:0] memory_m [0:DEPTH-1];

  assign rd_data_o = memory_m[rd_address_i];

  always_ff @(posedge clk_i) begin
    if (wr_en_i) begin
      memory_m[wr_address_i] <= wr_data_i;
    end
  end

endmodule
`default_nettype wire
