`default_nettype none

module alu 
  import alu_pkg::*;
  # (
    parameter int N = 8
  ) (
  input  logic [N-1:0] op_a_i,
  input  logic [N-1:0] op_b_i,
  input  logic [  3:0] opcode_i,
  output logic         overflow_o,
  output logic         zero_o,
  output logic [N-1:0] result_o
);

  // add_sub signals
  logic ctrl_w, overflow_w;
  logic [N-1:0] result_w;
  // comparator signals
  logic less_w, equal_w, greater_w;
  // min/max signals
  logic [N-1:0] mux_max_w, mux_min_w;
  // shift signals
  logic [N-1:0] sll_w, slr_w;
  // and, or, xor signals
  logic [N-1:0] and_w, or_w, xor_w;
  // zero
  const logic [N-1:0] zero_w = { N{1'b0} };
  
  // min/max logic
  assign mux_max_w = greater_w ? op_a_i : op_b_i;
  assign mux_min_w = less_w    ? op_a_i : op_b_i;
  // shift logic
  assign sll_w = op_a_i << op_b_i;
  assign slr_w = op_a_i >> op_b_i;
  // and, or, xor logic
  assign and_w = op_a_i & op_b_i;
  assign or_w  = op_a_i | op_b_i;
  assign xor_w = op_a_i ^ op_b_i;
  // add_sub
  add_sub_N #(.N (N)) i_add_sub_N (
    .a_i       (op_a_i),
    .b_i       (op_b_i),
    .ctrl_i    (ctrl_w),
    .result_o  (result_w),
    .overflow_o(overflow_w)
  );
  // comparator
  comparator_N #(.N (N)) i_comparator_N (
    .a_i       (op_a_i),
    .b_i       (op_b_i),
    .less_o    (less_w),
    .equal_o   (equal_w),
    .greater_o (greater_w)
  );

  always_comb begin: gen_opcode
    case (opcode_i)
      OP_ADD : begin
        result_o = result_w;
        zero_o   = result_w == zero_w;
      end
      OP_SUB : begin
        result_o = result_w;
        zero_o   = result_w == zero_w;
      end
      OP_MAX : begin
        result_o = mux_max_w;
        zero_o   = mux_max_w == zero_w;
      end
      OP_MIN : begin
        result_o = mux_min_w;
        zero_o   = mux_min_w == zero_w;
      end
      OP_EQL : begin
        result_o = {{(N-1){1'b0}}, equal_w};
        zero_o   = equal_w == 1'b0;
      end
      OP_SLL : begin
        result_o = sll_w;
        zero_o   = sll_w == zero_w;
      end
      OP_SLR : begin
        result_o = slr_w;
        zero_o   = slr_w == zero_w;
      end
      OP_AND : begin
        result_o = and_w;
        zero_o   = and_w == zero_w;
      end
      OP_OR  : begin
        result_o = or_w;
        zero_o   = or_w == zero_w;
      end
      OP_XOR : begin
        result_o = xor_w;
        zero_o   = xor_w == zero_w;
      end
      default: begin
        result_o = { N{1'b1} };
        zero_o   = 1'b1;
      end
    endcase
  end: gen_opcode

  assign ctrl_w = opcode_i == OP_SUB ? 1'b1 : 1'b0;
  always_comb begin
    if (opcode_i == OP_ADD || opcode_i == OP_SUB) overflow_o = overflow_w;
    else                                          overflow_o = opcode_i >= OP_MAX && opcode_i <= OP_XOR ? 1'b0 :1'b1;
  end

endmodule
`default_nettype wire
