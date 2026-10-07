`timescale 1ns/1ps
module tb;
  reg clk=0, reset=1, enable=0;
  wire [3:0] fast, slow;
  counter dut(.clk(clk), .reset(reset), .enable(enable), .fast(fast), .slow(slow));
  always #5 clk = ~clk;
  initial begin
    #12 reset=0; enable=1;
    #100;
    if (fast !== 10 || slow !== 5) $fatal(1, "Counter mismatch");
    #20 $finish;
  end
endmodule
