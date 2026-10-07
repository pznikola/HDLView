`default_nettype none

module fifo #(
  parameter DSIZE = 8,
  parameter ASIZE = 8
) (
  input  logic             clk_i,     // clock 
  input  logic             rst_ni,    // async reset active at zero
  input  logic             wr_en_i,   // write enable
  input  logic             rd_en_i,   // read enable
  input  logic [DSIZE-1:0] wr_data_i, // data to write
  output logic [DSIZE-1:0] rd_data_o, // data to read
  output logic             wr_full_o, // full fifo flag
  output logic             rd_empty_o // empty fifo flag
);

// Local parameters
localparam DEPTH = 1 << ASIZE;

// Internal signals
logic [DSIZE-1:0] mem_m [0:DEPTH-1];  // Memory
logic [ASIZE-1:0] wr_ptr_r, rd_ptr_r; // Pointers
logic [ASIZE:0] fifo_counter_r;

assign rd_empty_o = fifo_counter_r == 0;
assign wr_full_o  = fifo_counter_r == DEPTH;

assign rd_data_o = mem_m[rd_ptr_r];

// Memory
always_ff @(posedge(clk_i)) 
  if(wr_en_i && !wr_full_o) 
    mem_m[wr_ptr_r] <= wr_data_i;

// Read and Write
always_ff @(posedge(clk_i), negedge(rst_ni)) begin
  if (!rst_ni) begin
    rd_ptr_r  <= 0;
    wr_ptr_r  <= 0;
  end
  else begin
    if(wr_en_i && !wr_full_o)  wr_ptr_r <= wr_ptr_r + 1;
    if(rd_en_i && !rd_empty_o) rd_ptr_r <= rd_ptr_r + 1;
  end
end

// FIFO counter
always_ff @(posedge(clk_i), negedge(rst_ni)) begin
  if (!rst_ni) begin
    fifo_counter_r <= 0;
  end
  else if ((wr_en_i && !wr_full_o) && (rd_en_i && !rd_empty_o)) begin
    fifo_counter_r <= fifo_counter_r;
  end
  else if (wr_en_i && !wr_full_o) begin
    fifo_counter_r <= fifo_counter_r + 1;
  end
  else if (rd_en_i && !rd_empty_o) begin
    fifo_counter_r <= fifo_counter_r - 1;
  end
  else begin
    fifo_counter_r <= fifo_counter_r;
  end
end

endmodule

`default_nettype wire
