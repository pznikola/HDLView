`timescale 1ns/100ps

`define CLK_PERIOD 4
`define MAX_DATA   50

module edge_detector_tb ();
  // variables
  int counter = 0;

  // signals
  logic clk = 1'b0;
  logic rst_n = 1'b0;
  logic data_i = 1'b0;
  logic rising_edge_o;
  logic falling_edge_o;
  logic both_edges_o;

  edge_detector i_edge_detector (
    .clk_i(clk),
    .rst_ni(rst_n),
    .data_i(data_i),
    .rising_edge_o(rising_edge_o),
    .falling_edge_o(falling_edge_o),
    .both_edges_o(both_edges_o)
  );

  // toggle clock
  always #(`CLK_PERIOD/2) clk <= ~clk;

  // Dump *.vcd and check if enough data was send, and if so terminate test
	initial begin
    $dumpfile("edge_detector.vcd");
    $dumpvars(0, edge_detector_tb);
		wait(counter == `MAX_DATA);
		$finish;
	end

  initial begin: gen_rst
    #(2.3*`CLK_PERIOD)
    rst_n = 1'b1;
  end

  // generate random data
  always @(posedge clk or negedge rst_n) begin
    if (rst_n != 0) begin
    #0.5
    counter <= counter + 1;
    /* verilator lint_off WIDTHTRUNC */
    data_i <= $urandom_range(0, 1);
    /* verilator lint_on WIDTHTRUNC */
    end
  end

  // Check results
  always @(posedge data_i or negedge rst_n) begin
    #0.1
     if (rst_n != 0) begin
      if (rising_edge_o === 'b1) begin
        $display("%03d [ns]: [PASSED]: Rising edge detected.", $time);
      end else begin
        $error("%03d [ns]: [FAILED]: Rising edge was not detected.", $time);
      end
     end
  end

  always @(negedge data_i or negedge rst_n) begin
    #0.1
     if (rst_n != 0) begin
      if (falling_edge_o === 'b1) begin
        $display("%03d [ns]: [PASSED]: Falling edge detected.", $time);
      end else begin
        $error("%03d [ns]: [FAILED]: Falling edge was not detected.", $time);
      end
     end
  end

  always @(posedge data_i or negedge data_i or negedge rst_n) begin
    #0.1
     if (rst_n != 0) begin
      if (both_edges_o === 'b1) begin
        $display("%03d [ns]: [PASSED]: Rising or falling edge detected.", $time);
      end else begin
        $error("%03d [ns]: [FAILED]: Rising or falling edge was not detected.", $time);
      end
     end
  end
endmodule
