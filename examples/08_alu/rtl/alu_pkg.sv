package alu_pkg;

  // Supported ALU opcodes
  typedef enum logic [3:0] {
    OP_ADD = 4'd0,
    OP_SUB = 4'd1,
    OP_MAX = 4'd2,
    OP_MIN = 4'd3,
    OP_EQL = 4'd4,
    OP_SLL = 4'd5,
    OP_SLR = 4'd6,
    OP_AND = 4'd7,
    OP_OR  = 4'd8,
    OP_XOR = 4'd9
  } opcode_e;

endpackage
