`timescale 1ns/1ps
module tb;
  logic clk = 0, reset = 1, enable = 1, write = 0;
  logic [7:0] a = 8'h35, b = 8'h0f;
  logic [1:0] select = 0;
  logic [3:0] request = 4'b0100;
  logic [2:0] address = 0;
  wire [7:0] result, count, data;
  wire [3:0] decoded;
  wire [1:0] encoded;
  showcase dut (.*);
  always #5 clk = ~clk;
  initial begin
    #12 reset = 0;
    #10 select = 1;
    #10 select = 2;
    #10 write = 1;
    #10 write = 0;
    #10;
    if (count !== 5 || encoded !== 2 || decoded !== 4'b0100) $fatal(1, "showcase mismatch");
    $finish;
  end
endmodule
