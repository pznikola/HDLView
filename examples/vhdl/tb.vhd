library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity tb is end;
architecture sim of tb is
  signal clk : std_logic := '0';
  signal reset : std_logic := '1';
  signal enable : std_logic := '1';
  signal count : unsigned(3 downto 0);
begin
  dut : entity work.counter port map(clk, reset, enable, count);
  clk <= not clk after 5 ns;
  process begin
    wait for 12 ns; reset <= '0'; wait for 100 ns;
    assert count=10 report "Counter mismatch" severity failure;
    std.env.stop; wait;
  end process;
end architecture;
