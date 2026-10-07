`default_nettype none

module bin2gray #(
  parameter N = 4
) (
  input  logic [N-1:0] bin_i,
  output logic [N-1:0] gray_o
);
 assign gray_o = (bin_i>>1) ^ bin_i;
endmodule

`default_nettype wire
