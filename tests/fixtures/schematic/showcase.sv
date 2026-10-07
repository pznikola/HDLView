module showcase (
  input logic clk, reset, enable,
  input logic [7:0] a, b,
  input logic [1:0] select,
  input logic [3:0] request,
  input logic [2:0] address,
  input logic write,
  output logic [7:0] result, count, data,
  output logic [3:0] decoded,
  output logic [1:0] encoded
);
  logic [7:0] memory [0:7];
  function automatic logic [7:0] increment(input logic [7:0] value);
    return value + 1'b1;
  endfunction
  task automatic accumulate(input logic [7:0] value);
    result = result + value;
  endtask
  always_comb begin
    case (select)
      2'd0: result = a & b;
      2'd1: result = a ^ b;
      2'd2: result = a + b;
      default: result = {a[3:0], b[3:0]};
    endcase
    for (int i = 0; i < 1; i = i + 1) begin
      accumulate({8{enable}});
    end
  end
  assign decoded = {select == 2'd3, select == 2'd2, select == 2'd1, select == 2'd0};
  assign encoded = request[3] ? 2'd3 : request[2] ? 2'd2 : request[1] ? 2'd1 : 2'd0;
  always_ff @(posedge clk) begin
    if (reset) count <= '0;
    else if (enable) count <= increment(count);
    if (write) memory[address] <= a;
    data <= memory[address];
  end
endmodule
