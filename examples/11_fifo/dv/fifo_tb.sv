`timescale 1ns / 1ps

`ifndef DSIZE
  `define DSIZE 8
`endif
`ifndef ASIZE
  `define ASIZE 8
`endif
`define PERIOD 4

module fifo_tb;

// Test Signals
logic clk_i   = 0;             
logic rst_ni  = 1;           
logic wr_en_i = 0;     
logic rd_en_i = 0;      
logic [`DSIZE-1 : 0] wr_data_i = 0;
logic [`DSIZE-1 : 0] rd_data_o; 
logic wr_full_o;            
logic rd_empty_o;

// DUT
fifo #(.DSIZE(`DSIZE), .ASIZE(`ASIZE)) u_fifo(.*);

// Dump VCD
initial begin
  $dumpfile("fifo.vcd");
	$dumpvars(0, fifo_tb);
end

// Clock Generation
always begin
  #(`PERIOD/2); 
  clk_i <= ~clk_i; 
end

// Test Scenario
initial begin
    // Initial reset
    rst_ni = ~rst_ni;
    #(2.2*`PERIOD);
    // Sync clock
    @(posedge(clk_i));

    rst_ni = ~rst_ni;
    #`PERIOD;
    
    // Write Until Full
    for(int i = 1; (i <= 2**`ASIZE) && !wr_full_o; ++i) begin
        wr_data_i = `DSIZE'(i);
        wr_en_i    = 1'b1;
        #`PERIOD;
    end
    wr_en_i = 1'b0;
    #`PERIOD;
    
    assert (wr_full_o == 1'b1) $display("%c[1;32m[PASSED]%c[0m fifo full.", 8'd27, 8'd27);
    else $error("%c[1;31m[FAILED]%c[0m fifo was expected to be full but it is not.", 8'd27, 8'd27);
    
    // Read unless rd_empty_o
    for(int i = 1; (i <= 2**`ASIZE) && !rd_empty_o; ++i) begin
      // To avoid race, sample at the midle of transition
      @(negedge(clk_i));     

      assert (rd_data_o == `DSIZE'(i)) $display("%c[1;32m[PASSED]%c[0m Read data is same as written data.", 8'd27, 8'd27);
      else $error("%c[1;31m[FAILED]%c[0m Read data was 0x%0h, but it is expected to be 0x%0h.", 8'd27, 8'd27, rd_data_o, i);
      
      rd_en_i = 1'b1;
      #`PERIOD;  
    end
    rd_en_i = 1'b0;
    #`PERIOD;  
    
    assert (rd_empty_o == 1'b1) $display("%c[1;32m[PASSED]%c[0m fifo empty.", 8'd27, 8'd27);
    else $error("%c[1;31m[FAILED]%c[0m fifo was expected to be empty but it is not.", 8'd27, 8'd27);
    
    @(posedge(clk_i));  // Synchronize again
    
    // Write and Read at the same time while rd_empty_o
    wr_data_i = `DSIZE'($urandom_range((1<<`DSIZE) - 1, 0));
    wr_en_i   = 1'b1;
    rd_en_i   = 1'b1;
    #`PERIOD;
    wr_en_i   = 1'b0;
    rd_en_i   = 1'b0;
    #`PERIOD;
    
    wr_data_i = `DSIZE'($urandom_range((1<<`DSIZE) - 1, 0));
    wr_en_i   = 1'b1;
    rd_en_i   = 1'b1;
    #`PERIOD;
    wr_en_i   = 1'b0;
    rd_en_i   = 1'b0;
    #`PERIOD;
    
    assert (rd_empty_o == 1'b0) $display("%c[1;32m[PASSED]%c[0m fifo was not empty.", 8'd27, 8'd27);
    else $error("%c[1;31m[FAILED]%c[0m fifo was empty but it should't be.", 8'd27, 8'd27);
    
    // rst_ni Again
    rst_ni = ~rst_ni;
    #`PERIOD;
    rst_ni = ~rst_ni;
    
    // Fill completely
    for(int i = 0; (i < 2**`ASIZE) && !wr_full_o; ++i) begin
        wr_data_i = `DSIZE'(i);
        wr_en_i    = 1'b1;
        #`PERIOD;
    end
    wr_en_i = 1'b0;
    #`PERIOD;
    
    assert (wr_full_o == 1'b1) $display("%c[1;32m[PASSED]%c[0m fifo full.", 8'd27, 8'd27);
    else $error("%c[1;31m[FAILED]%c[0m fifo was expected to be full but it is not.", 8'd27, 8'd27);
        
    // Write and Read at the same time while wr_full_o
    wr_data_i = `DSIZE'($urandom_range((1<<`DSIZE) - 1, 0));
    wr_en_i    = 1'b1;
    rd_en_i    = 1'b1;
    #`PERIOD;
    wr_en_i    = 1'b0;
    rd_en_i    = 1'b0;
    #`PERIOD;
    
    wr_data_i = `DSIZE'($urandom_range((1<<`DSIZE) - 1, 0));
    wr_en_i    = 1'b1;
    rd_en_i    = 1'b1;
    #`PERIOD;
    wr_en_i    = 1'b0;
    rd_en_i    = 1'b0;
    #`PERIOD;
    
    assert (wr_full_o == 1'b0) $display("%c[1;32m[PASSED]%c[0m fifo is not full.", 8'd27, 8'd27);
    else $error("%c[1;31m[FAILED]%c[0m fifo was full but is shouldn't be.", 8'd27, 8'd27);
        
    $finish;
end

endmodule
