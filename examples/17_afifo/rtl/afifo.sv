`default_nettype none

module afifo #(
  parameter DSIZE = 8,
  parameter ASIZE = 8
)(
  input              wr_clk_i,
  input              wr_rst_ni,
  input              rd_clk_i,
  input              rd_rst_ni,
  input              wr_en_i,
  input              rd_en_i,
  input  [DSIZE-1:0] wr_data_i,
  output [DSIZE-1:0] rd_data_o,
  output             wr_full_o,
  output             rd_empty_o
);
  
  logic [ASIZE-1:0] wr_address_w, rd_address_w;
  logic [ASIZE  :0] wr_pointer_w, rd_pointer_w;
  logic [ASIZE  :0] wr_sync_pointer_w, rd_sync_pointer_w;

  // sync read pointer to write clock
  sync_ff #(.N(ASIZE + 1)) i_sync_r2w(
    .rd_clk_i(wr_clk_i),
    .rd_rst_ni(wr_rst_ni),
    .wr_data_i(rd_pointer_w),
    .rd_data_o(rd_sync_pointer_w)
  );
  // sync write pointer to read clock
  sync_ff #(.N(ASIZE + 1)) i_sync_w2r(
    .rd_clk_i(rd_clk_i),
    .rd_rst_ni(rd_rst_ni),
    .wr_data_i(wr_pointer_w),
    .rd_data_o(wr_sync_pointer_w)
  );

  mem #(.DSIZE(DSIZE), .ASIZE(ASIZE)) i_mem (
    .clk_i(wr_clk_i),
    .wr_en_i(wr_en_i & !wr_full_o),
    .wr_data_i(wr_data_i),
    .wr_address_i(wr_address_w),
    .rd_address_i(rd_address_w),
    .rd_data_o(rd_data_o)
  );

  rd_pointer #(.ASIZE(ASIZE)) i_rd_pointer (
    .rd_clk_i(rd_clk_i),
    .rd_rst_ni(rd_rst_ni),
    .rd_en_i(rd_en_i),
    .wr_sync_pointer_i(wr_sync_pointer_w),
    .rd_pointer_o(rd_pointer_w),
    .rd_address_o(rd_address_w),
    .rd_empty_o(rd_empty_o)
  );

  wr_pointer #(.ASIZE(ASIZE)) i_wr_pointer (
    .wr_clk_i(wr_clk_i),
    .wr_rst_ni(wr_rst_ni),
    .wr_en_i(wr_en_i),
    .rd_sync_pointer_i(rd_sync_pointer_w),
    .wr_pointer_o(wr_pointer_w),
    .wr_address_o(wr_address_w),
    .wr_full_o(wr_full_o)
  );

endmodule
`default_nettype wire
