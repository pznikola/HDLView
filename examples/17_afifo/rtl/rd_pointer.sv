`default_nettype none

module rd_pointer #(
  parameter ASIZE = 4
)(
  input  logic             rd_clk_i,
  input  logic             rd_rst_ni,
  input  logic             rd_en_i,
  input  logic [ASIZE  :0] wr_sync_pointer_i,
  output logic [ASIZE  :0] rd_pointer_o,
  output logic [ASIZE-1:0] rd_address_o,
  output logic             rd_empty_o
);
  reg  [ASIZE:0] rd_bin_r;
  wire rd_empty_w;
  wire [ASIZE:0] rd_gray_next_w, rd_bin_next_w;

  //-------------------
  // GRAYSTYLE2 pointer
  //-------------------
  always_ff @(posedge rd_clk_i or negedge rd_rst_ni)
    if (!rd_rst_ni) {rd_bin_r, rd_pointer_o} <= 0;
    else            {rd_bin_r, rd_pointer_o} <= {rd_bin_next_w, rd_gray_next_w};

  // Memory read-address pointer (okay to use binary to address memory)
  assign rd_address_o = rd_bin_r[ASIZE-1:0];
  assign rd_bin_next_w   = rd_bin_r + (ASIZE+1)'(rd_en_i & 1'(~rd_empty_o));
  assign rd_gray_next_w  = (rd_bin_next_w>>1) ^ rd_bin_next_w;

  //---------------------------------------------------------------
  // FIFO empty when the next rd_pointer_o == synchronized wr_pointer or on reset
  //---------------------------------------------------------------
  assign rd_empty_w = (rd_gray_next_w == wr_sync_pointer_i);

  always_ff @(posedge rd_clk_i or negedge rd_rst_ni)
    if (!rd_rst_ni) rd_empty_o <= 1'b1;
    else            rd_empty_o <= rd_empty_w;

endmodule
`default_nettype wire
