`timescale 1ns/1ps
module gate_tb;
  reg clk=0, reset=1, enable=1;
  wire [3:0] count;
  counter dut(.clk(clk), .reset(reset), .enable(enable), .count(count));
  always #5 clk=~clk;
  initial begin
    #12 reset=0;
    #100;
    if (count !== 4'd10) $fatal(1,"Unexpected gate counter: %d",count);
    $finish;
  end
endmodule
