`default_nettype none

module shift_register 
  # (
    parameter int N = 8
  ) (
  input  logic         clk_i,
  input  logic         rst_ni,
  input  logic         en_i,
  input  logic         serial_i,
  output logic [N-1:0] parallel_o
);

  logic [N-1:0] data_r;

  always_ff @(posedge(clk_i) or negedge(rst_ni)) begin: gen_dff
    if (!rst_ni)   data_r <= 'b0;
    else if (en_i) data_r <= {data_r[N-2:0], serial_i};
    else           data_r <= data_r;
  end

  assign parallel_o = data_r;

endmodule
`default_nettype wire
