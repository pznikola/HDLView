library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity counter is
  port (clk, reset, enable : in std_logic; count : out unsigned(3 downto 0));
end entity;
architecture rtl of counter is
  signal value : unsigned(3 downto 0);
begin
  process(clk)
  begin
    if rising_edge(clk) then
      if reset='1' then value <= (others=>'0');
      elsif enable='1' then value <= value+1;
      end if;
    end if;
  end process;
  count <= value;
end architecture;
