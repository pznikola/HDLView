`timescale 1ns/100ps

`ifndef N
  `define N 8
`endif
`define CLK_PERIOD 4
`define MAX_DATA   100

module simple_lfsr_tb ();
  // variables
  int counter = 0;

  // signals
  logic          clk = 1'b0;
  logic          rst_n = 1'b0;
  logic          en_i;
  logic [`N-1:0] parallel_o;
  // gold data
  logic [`N-1:0] gold_r;

  simple_lfsr #(.N (`N)) i_simple_lfsr (
    .clk_i(clk),
    .rst_ni(rst_n),
    .en_i(en_i),
    .parallel_o(parallel_o)
  );

  // toggle clock
  always #(`CLK_PERIOD/2) clk <= ~clk;

  // Reset
  initial begin: gen_rst
    #(2.3*`CLK_PERIOD)
    rst_n = 1'b1;
    wait(counter == (`MAX_DATA/4))
    rst_n = 1'b0;
    #(`CLK_PERIOD)
    rst_n = 1'b1;
  end

  // Dump *.vcd and check if enough data was send, and if so terminate test
	initial begin
    $dumpfile("simple_lfsr.vcd");
    $dumpvars(0, simple_lfsr_tb);
		wait(counter == `MAX_DATA);
		$finish;
	end

  // Gold model - TODO: Think how to do this better
  always_ff @(posedge(clk) or negedge(rst_n)) begin
    if (!rst_n)    gold_r <= {(`N){1'b1}};
    else if (en_i) gold_r <= {gold_r[`N-2:0], gold_r[`N-1] ^ gold_r[`N-2]};
    else           gold_r <= gold_r;
  end

  // generate random data
  always @(posedge clk or negedge rst_n) begin
    if (rst_n != 0) begin
    #0.5
    counter <= counter + 1;
    /* verilator lint_off WIDTHTRUNC */
    en_i <= $urandom_range(0, 1);
    /* verilator lint_on WIDTHTRUNC */
    end
  end

  // Check result
  always @(posedge clk or negedge rst_n) begin
    #0.1
      if (parallel_o === gold_r) begin
        $display("%03d [ns]: [PASSED]: parallel_o (hex: 0x%b) == expected (hex: 0x%b)", $time, parallel_o, gold_r);
      end else begin
        $error("%03d [ns]: [FAILED]: parallel_o (hex: 0x%b) != expected (hex: 0x%b)", $time, parallel_o, gold_r);
      end
    end
endmodule
