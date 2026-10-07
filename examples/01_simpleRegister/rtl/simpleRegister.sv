`default_nettype none

module simpleRegister 
  # (
    parameter int N = 8
  ) (
  input  logic         clk_i,
  input  logic         rst_ni,
  input  logic [N-1:0] data_i,
  output logic [N-1:0] data_o
);

  always_ff @(posedge(clk_i) or negedge(rst_ni)) begin: gen_dff
    if (!rst_ni) data_o <= 'b0;
    else         data_o <= data_i;
  end

endmodule
`default_nettype wire
