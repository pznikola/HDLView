`timescale 1ns/100ps

`ifndef DSIZE
  `define DSIZE 8
`endif
`ifndef ASIZE
  `define ASIZE 8
`endif
`define MAX_RANGE ((1 << `DSIZE) - 1)
`define MAX_DATA  400
`define PERIOD 2

module mem_tb ();
  // signals
  logic clk_i = 0, wr_en_i = 0;
  logic [`DSIZE-1:0] wr_data_i;
  logic [`ASIZE-1:0] wr_address_i;
  logic [`ASIZE-1:0] rd_address_i;
  logic [`DSIZE-1:0] rd_data_o;
  // gold data
  logic [`DSIZE-1:0] gold_m [0:(1 << `ASIZE)-1];
  logic [`DSIZE-1:0] gold_data_o;

  mem #(
    .DSIZE (`DSIZE),
    .ASIZE (`ASIZE)
  ) i_mem (
    .clk_i(clk_i),
    .wr_en_i(wr_en_i),
    .wr_data_i(wr_data_i),
    .wr_address_i(wr_address_i),
    .rd_address_i(rd_address_i),
    .rd_data_o(rd_data_o)
  );


  // Read and write random data to random addresses
  initial begin
    for (int i = 0; i <= `MAX_DATA; i++) begin
      @(negedge clk_i)
      wr_en_i      = 1'($urandom_range(1, 0));
      wr_address_i = `ASIZE'($urandom_range((1<<`ASIZE) - 1, 0));
      rd_address_i = `ASIZE'($urandom_range((1<<`ASIZE) - 1, 0));
      wr_data_i    = `DSIZE'($urandom_range((1<<`DSIZE) - 1, 0));
      #`PERIOD;
    end
    #`PERIOD;
    $finish;
  end
    
  // gold model
  always_ff @(posedge clk_i) begin
    if (wr_en_i) begin
      gold_m[wr_address_i] <= wr_data_i;
    end
  end
  assign gold_data_o = gold_m[rd_address_i];

  // Clock Generation
  always begin
    #(`PERIOD/2.0); 
    clk_i <= ~clk_i; 
  end

    // Check result
  always @(posedge clk_i) begin
    #0.1
      if (gold_data_o === rd_data_o) begin
        $display("%03d [ns]: [PASSED]: rd_address_i (0hex: %H), rd_data_o (hex: %H) == expected (hex: %H)", $time, rd_address_i, rd_data_o, gold_data_o);
      end else begin
        $error("%03d [ns]: [FAILED]: rd_address_i (hex: %H), rd_data_o (hex: %H) != expected (hex: %H)", $time, rd_address_i, rd_data_o, gold_data_o);
      end
    end

endmodule
