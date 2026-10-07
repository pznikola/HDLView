`timescale 1ns/100ps

`ifndef N
  `define N 8
`endif
`define MAX_RANGE ((1 << `N) - 1)
`define MAX_DATA  100

module gray2bin_tb ();

  // signals
  logic [`N-1:0] bin_o;
  logic [`N-1:0] gray_i;
  // gold data
  logic [`N-1:0] gold_w;

  gray2bin #(.N (`N)) i_gray2bin (
    .bin_o(bin_o),
    .gray_i(gray_i)
  );

  // Dump *.vcd and check if enough data was send, and if so terminate test
	initial begin
    $dumpfile("gray2bin.vcd");
    $dumpvars(0, gray2bin_tb);
	end

  // Gold model - TODO: Think how to do this better
  function automatic logic [`N-1:0] gray2bin(input logic [`N-1:0] g);
    for (int i = 0; i < `N; i++) begin
      gray2bin[i] = ^(g >> i);
    end
  endfunction
  
  assign gold_w = gray2bin(gray_i);

 initial begin
    for (int i = 0; i <= `MAX_DATA; i++) begin
      /* verilator lint_off WIDTHTRUNC */
      gray_i = $urandom_range(0, `MAX_RANGE);
      /* verilator lint_on WIDTHTRUNC */
      #2;
    end
    #2
    $finish;
  end

  // Check result
  always @(bin_o) begin
    #0.1
      if (bin_o === gold_w) begin
        $display("%03d [ns]: [PASSED]: gray_i (bin: %b), bin_o (bin: %b) == expected (bin: %b)", $time, gray_i, bin_o, gold_w);
      end else begin
        $error("%03d [ns]: [FAILED]: gray_i (bin: %b), bin_o (bin: %b) != expected (bin: %b)", $time, gray_i, bin_o, gold_w);
      end
    end
endmodule
