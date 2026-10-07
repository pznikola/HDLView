`timescale 1ns/1ps
module tb;
  reg [4:7] a=4'h6;
  wire [7:4] y;
  bridge dut(.a(a),.y(y));
  initial begin
    #2;
    if (y!==4'h6) $fatal(1,"Range correspondence mismatch");
    a=4'h9;
    #2;
    if (y!==4'h9) $fatal(1,"Range correspondence mismatch");
    $finish;
  end
endmodule
