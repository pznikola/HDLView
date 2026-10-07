`default_nettype none

module wr_pointer #(
  parameter ASIZE = 4
)(
  input  logic             wr_clk_i,
  input  logic             wr_rst_ni,
  input  logic             wr_en_i,
  input  logic [ASIZE  :0] rd_sync_pointer_i,
  output logic             wr_full_o,
  output logic [ASIZE-1:0] wr_address_o,
  output logic [ASIZE  :0] wr_pointer_o
);
  reg  [ASIZE:0] wr_bin_r;
  wire           wr_full_w;
  wire [ASIZE:0] wr_gray_next_w, wr_bin_next_w;

  // GRAYSTYLE2 pointer
  always_ff @(posedge wr_clk_i or negedge wr_rst_ni)
    if (!wr_rst_ni) {wr_bin_r, wr_pointer_o} <= 0;
    else            {wr_bin_r, wr_pointer_o} <= {wr_bin_next_w, wr_gray_next_w};

  // Memory write-address pointer (okay to use binary to address memory)
  assign wr_address_o   = wr_bin_r[ASIZE-1:0];
  assign wr_bin_next_w  = wr_bin_r + (ASIZE+1)'(wr_en_i & 1'(~wr_full_o));
  assign wr_gray_next_w = (wr_bin_next_w>>1) ^ wr_bin_next_w;

  //--------------------------------------------------------------------------------------------------------
  // Simplified version of the three necessary full-tests:
  // assign wr_full_w=((wr_gray_next_w[ASIZE] != rd_sync_pointer_i[ASIZE] ) &&
  //                                             (wr_gray_next_w[ASIZE-1] !=rd_sync_pointer_i[ASIZE-1]) &&
  //                                             (wr_gray_next_w[ASIZE-2:0]==rd_sync_pointer_i[ASIZE-2:0]));
  //--------------------------------------------------------------------------------------------------------
  assign wr_full_w = (wr_gray_next_w=={~rd_sync_pointer_i[ASIZE:ASIZE-1],rd_sync_pointer_i[ASIZE-2:0]});

  always_ff @(posedge wr_clk_i or negedge wr_rst_ni)
    if (!wr_rst_ni) wr_full_o <= 1'b0;
    else            wr_full_o <= wr_full_w;

endmodule
`default_nettype wire
