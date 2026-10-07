`timescale 1ns/100ps

`ifndef N
  `define N 8
`endif
`define MAX_RANGE ((1 << `N) - 1)
`define MAX_DATA 50

module alu_tb 
  import alu_pkg::*;
  ();
  
  // signals
  logic signed [`N-1:0] op_a_i;
  logic signed [`N-1:0] op_b_i;
  logic [   3:0] opcode_i;
  logic          overflow_o;
  logic          zero_o;
  logic signed [`N-1:0] result_o;
  // test signals
  logic [`N-1:0] gold_result_w;
  logic          gold_zero_w;
  logic          gold_overflow_w;

  // map opcode to string
  typedef logic [8*6-1:0] str6_t;
  str6_t opcode_map[0:15];
  initial begin
    opcode_map[ 0] = "OP_ADD";
    opcode_map[ 1] = "OP_SUB";
    opcode_map[ 2] = "OP_MAX";
    opcode_map[ 3] = "OP_MIN";
    opcode_map[ 4] = "OP_EQL";
    opcode_map[ 5] = "OP_SLL";
    opcode_map[ 6] = "OP_SLR";
    opcode_map[ 7] = "OP_AND";
    opcode_map[ 8] = "OP_OR ";
    opcode_map[ 9] = "OP_XOR";
    opcode_map[10] = "NO_OP ";
    opcode_map[11] = "NO_OP ";
    opcode_map[12] = "NO_OP ";
    opcode_map[13] = "NO_OP ";
    opcode_map[14] = "NO_OP ";
    opcode_map[15] = "NO_OP ";
  end

  function automatic bit gold_overflow_ext (input logic signed [`N-1:0] a, input logic signed [`N-1:0] b, input logic c, input logic ctrl);
    /* verilator lint_off UNUSEDSIGNAL */
    logic signed [`N:0] result_extended;
    
    if (ctrl) result_extended = $signed({a[`N-1], a}) - $signed({b[`N-1], b});
    else      result_extended = $signed({a[`N-1], a}) + $signed({b[`N-1], b}) + $signed({{(`N-1){1'b0}}, c});

    return result_extended[`N] ^ result_extended[`N-1];
    /* verilator lint_on UNUSEDSIGNAL */
  endfunction

  alu i_alu (
    .op_a_i    (op_a_i),
    .op_b_i    (op_b_i),
    .opcode_i  (opcode_i),
    .overflow_o(overflow_o),
    .zero_o    (zero_o),
    .result_o  (result_o)
  );

  // Dump *.vcd and check if enough data was send, and if so terminate test
	initial begin
    $dumpfile("alu.vcd");
    $dumpvars(0, alu_tb);
	end

  initial begin
    for (int opcode = 0; opcode < 11; opcode++) begin
      opcode_i = 4'(opcode);
      for (int i = 0; i < `MAX_DATA; i++) begin
        if (opcode_i != OP_SLL && opcode_i != OP_SLR) begin
          if (i % 10 == 0) begin
            op_a_i = `N'($urandom_range(0, `MAX_RANGE));
            op_b_i = op_a_i;
          end
          else begin
            op_a_i = `N'($urandom_range(0, `MAX_RANGE));
            op_b_i = `N'($urandom_range(0, `MAX_RANGE));
          end
        end
        else begin
            op_a_i = `N'($urandom_range(0, `MAX_RANGE));
            op_b_i = `N'($urandom_range(0, `N));
        end
        #2;
      end
    end
    $finish;
  end

  assign gold_zero_w  = opcode_i > OP_XOR ? 1'b1 : gold_result_w[`N-1:0] == {`N{1'b0}};

  always_comb begin: gen_test
    case (opcode_i)
      OP_ADD : begin
        gold_result_w = op_a_i + op_b_i;
        gold_overflow_w = gold_overflow_ext (op_a_i, op_b_i, 1'b0, 1'b0);
      end
      OP_SUB : begin
        gold_result_w   = op_a_i - op_b_i;
        gold_overflow_w = gold_overflow_ext (op_a_i, op_b_i, 1'b0, 1'b1);
      end
      OP_MAX : begin
        gold_result_w   = op_a_i > op_b_i ? op_a_i : op_b_i;
        gold_overflow_w = 1'b0;
      end
      OP_MIN : begin
        gold_result_w   = op_a_i < op_b_i ? op_a_i : op_b_i;
        gold_overflow_w = 1'b0;
      end
      OP_EQL : begin
        gold_result_w   = op_a_i == op_b_i ? {{(`N-1){1'b0}}, 1'b1} : {(`N){1'b0}};
        gold_overflow_w = 1'b0;
      end
      OP_SLL : begin
        gold_result_w   = op_a_i << op_b_i;
        gold_overflow_w = 1'b0;
      end
      OP_SLR : begin
        gold_result_w   = op_a_i >> op_b_i;
        gold_overflow_w = 1'b0;
      end
      OP_AND : begin
        gold_result_w   = op_a_i & op_b_i;
        gold_overflow_w = 1'b0;
      end
      OP_OR  : begin
        gold_result_w   = op_a_i | op_b_i;
        gold_overflow_w = 1'b0;
      end
      OP_XOR : begin
        gold_result_w   = op_a_i ^ op_b_i;
        gold_overflow_w = 1'b0;
      end
      default: begin
        gold_result_w   = { (`N){1'b1} };
        gold_overflow_w = 1'b1;
      end
    endcase
  end: gen_test

  // Check the results
  always @(*) begin
    #0.1
    if (overflow_o === gold_overflow_w && result_o === gold_result_w && zero_o === gold_zero_w) begin
      $display("%04d [ns]: [PASSED]: op_a_i = %d, op_b_i = %d, opcode_i = %s | result_o = %d, zero_o = %b, overflow_o = %b == expected: %d, %b, %b", $time, op_a_i, op_b_i, opcode_map[opcode_i], result_o, zero_o, overflow_o, gold_result_w, gold_zero_w, gold_overflow_w);
    end else begin
      $error("%04d [ns]: [FAILED]: op_a_i = %d, op_b_i = %d, opcode_i = %s | result_o = %d, zero_o = %b, overflow_o = %b != expected: %d, %b, %b", $time, op_a_i, op_b_i, opcode_map[opcode_i], result_o, zero_o, overflow_o, gold_result_w, gold_zero_w, gold_overflow_w);
    end
  end
endmodule
