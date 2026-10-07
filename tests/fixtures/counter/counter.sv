module lane #(parameter WIDTH=4) (input logic clk, reset, enable, output logic [WIDTH-1:0] count);
  always_ff @(posedge clk) begin
    if (reset) count <= '0;
    else if (enable) count <= count + 1'b1;
  end
endmodule
module counter(input logic clk, reset, enable, output wire [3:0] fast, slow);
  lane first(clk, reset, enable, fast);
  lane second(clk, reset, enable && fast[0], slow);
endmodule
