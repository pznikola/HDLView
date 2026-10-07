`timescale 1ns/100ps

`ifndef N
  `define N 8
`endif
`define MAX_RANGE ((1 << `N) - 1)
`define CLK_PERIOD 4
`define MAX_DATA   100

module simpleRegister_tb ();
  // variables
  int counter = 0;

  // signals
  logic          clk = 1'b0;
  logic          rst_n = 1'b0;
  logic [`N-1:0] data_i;
  logic [`N-1:0] data_o;
  logic [`N-1:0] test_data;

  simpleRegister #(.N (`N)) i_simpleRegister (
    .clk_i(clk),
    .rst_ni(rst_n),
    .data_i(data_i),
    .data_o(data_o)
  );

  // toggle clock
  always #(`CLK_PERIOD/2) clk <= ~clk;

  // Dump *.vcd and check if enough data was send, and if so terminate test
	initial begin
    $dumpfile("simpleRegister.vcd");
    $dumpvars(0, simpleRegister_tb);
		wait(counter == `MAX_DATA);
		$finish;
	end

  always @(posedge clk) begin
    test_data <= data_i;
    #(`CLK_PERIOD/4)
    counter <= counter + 1;
    /* verilator lint_off WIDTHTRUNC */
    data_i <= $urandom_range(0, `MAX_RANGE);
    // random reset, tweak the values
    #(2 / $urandom_range(2, 20));
    if ($urandom_range(0, 15) < 4) rst_n  <= 1'b0;
    else rst_n  <= 1'b1;
    /* verilator lint_on WIDTHTRUNC */
  end

  // Check result
  always @(posedge clk or negedge rst_n) begin
    #0.1
     if (rst_n == 0) begin: gen_rst_active
      if (data_o === 'b0) begin
        $display("%03d [ns]: [PASSED]: data_o (hex: 0x%H) == 0 when rst_n=0", $time, data_o);
      end else begin
        $error("%03d [ns]: [FAILED]: data_o (hex: 0x%H) != 0 when rst_n=0", $time, data_o);
      end
     end
     else begin:  gen_rst_inactive
      if (data_o === test_data) begin
        $display("%03d [ns]: [PASSED]: data_o (hex: 0x%H) == prev(data_i) (hex: 0x%H) when rst_n=1", $time, data_o, test_data);
      end else begin
        $error("%03d [ns]: [FAILED]: data_o (hex: 0x%H) != prev(data_i) (hex: 0x%H) when rst_n=1", $time, data_o, test_data);
      end
     end
  end
endmodule
