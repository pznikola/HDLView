`timescale 1ns/100ps

`ifndef N
  `define N 8
`endif
`define MAX_RANGE ((1 << `N) - 1)
`define MAX_DATA  100
`define WR_PERIOD 3
`define RD_PERIOD 2

module sync_ff_tb ();
  // signals
  logic [`N-1:0] wr_data_i, rd_data_o;
  logic wr_clk = 0, rd_clk = 0, wr_rst_n = 0, rd_rst_n = 0;
  // gold data
  logic [`N-1 : 0] queue_temp [$:1];
  logic [`N-1 : 0] temp_wr_data;
  logic [`N-1 : 0] temp_rd_data;

  sync_ff #(.N (`N)) i_sync_ff (
    .wr_data_i(wr_data_i),
    .rd_clk_i(rd_clk),
    .rd_rst_ni(rd_rst_n),
    .rd_data_o(rd_data_o)
  );

//  _   _      _                    __                  _   _                 
// | | | | ___| |_ __   ___ _ __   / _|_   _ _ __   ___| |_(_) ___  _ __
// | |_| |/ _ \ | '_ \ / _ \ '__| | |_| | | | '_ \ / __| __| |/ _ \| '_ \
// |  _  |  __/ | |_) |  __/ |    |  _| |_| | | | | (__| |_| | (_) | | | \
// |_| |_|\___|_| .__/ \___|_|    |_|  \__,_|_| |_|\___|\__|_|\___/|_| |_|
//              |_|                                                           
  task automatic single_write_and_read_fifo();
    fork 
      begin
        @(posedge(wr_clk));
        temp_wr_data = `N'($urandom_range((1<<`N) - 1, 0));
        queue_temp.push_front(temp_wr_data);
        wr_data_i = temp_wr_data;
        #`WR_PERIOD;
      end

      begin
        @(negedge(rd_clk));
        temp_rd_data = queue_temp.pop_back();
        assert (rd_data_o == temp_rd_data) $display("%03d [ns]: [PASSED]: rd_data_o (hex: 0x%h) == expected (hex: 0x%h)", $time, rd_data_o, temp_rd_data);
        else $error("%03d [ns]: [FAILED]: rd_data_o (hex: 0x%h) != expected (hex: 0x%h)", $time, rd_data_o, temp_rd_data);
        #`RD_PERIOD;
      end
    join
  endtask

  // Dump *.vcd and check if enough data was send, and if so terminate test
	initial begin
    $dumpfile("sync_ff.vcd");
    $dumpvars(0, sync_ff_tb);
	end

  // Reset
  initial begin
    fork
      begin
        #(3.2*`RD_PERIOD);
        // Sync @ clock
        @(posedge(rd_clk));
        rd_rst_n = ~rd_rst_n;
      end
      begin
        #(2.2*`WR_PERIOD);
        // Sync @ clock
        @(posedge(wr_clk));
        wr_rst_n = ~wr_rst_n;
      end
    join

    // The first read precedes the first write and must check the reset output.
    queue_temp.push_front('0);

    // single read and write
    for (int i = 0; i <= `MAX_DATA; i++) begin
      single_write_and_read_fifo();
    end
    $finish;
  end

  // Clock Generation
  always begin
    #(`WR_PERIOD/2.0); 
    wr_clk <= ~wr_clk; 
  end
  always begin
    #(`RD_PERIOD/2.0); 
    rd_clk <= ~rd_clk; 
  end
endmodule
