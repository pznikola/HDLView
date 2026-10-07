`default_nettype none

module gray2bin #(
  parameter N = 4
) (
  input  logic [N-1:0] gray_i,
  output logic [N-1:0] bin_o
);
 
  always_comb begin
    for (int i=0; i<N; i++) begin
      bin_o[i] = ^(gray_i >> i);
    end
  end
endmodule
`default_nettype wire
