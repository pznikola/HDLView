"""What a testbench written for the RTL still needs beside a synthesized netlist.

Parameters: a netlist has none, so a testbench that sets one on the DUT would
not compile. The first output declares the top's elaborated parameters, each
followed by a check: a different value than the one synthesized is an error,
never a silently wrong simulation.

Packages: the second output lists, in compilation order, the design sources
that declare only packages, which a testbench may import.
"""
import json
import pathlib
import shlex
import sys
import pyslang as sv
output = pathlib.Path(sys.argv[1])
packages = pathlib.Path(sys.argv[2])
# pyslang 11 moved Driver into a submodule.
driver = getattr(sv, "driver", sv).Driver()
driver.addStandardArgs()
if not driver.parseCommandLine("slang " + shlex.join(sys.argv[3:])) or not driver.processOptions() or not driver.parseAllSources():
    raise RuntimeError("Could not parse the design sources")
compilation = driver.createCompilation()
tops = compilation.getRoot().topInstances
if compilation.hasIssuedErrors or len(tops) != 1:
    driver.reportDiagnostics(False)
    raise RuntimeError("Could not elaborate the design top")
top = tops[0]
lines = []
for parameter in top.body.parameters:
    # Type parameters and aggregate values have no netlist equivalent.
    if parameter.isLocalParam or not hasattr(parameter, "value"):
        continue
    kind = parameter.type.canonicalType
    if not (kind.isSimpleBitVector or kind.isFloating or kind.isString):
        continue
    name, value = parameter.name, str(parameter.value)
    differs = "!==" if kind.isSimpleBitVector else "!="
    message = f"{top.name} was built with {name} = {value}; the testbench sets another value"
    lines.append(f"  parameter {kind} {name} = {value};")
    lines.append(f"  if ({name} {differs} {value}) $fatal(1, {json.dumps(message)});")
output.write_text("".join(line + "\n" for line in lines))
package_files = set()
for tree in driver.syntaxTrees:
    members = list(tree.root.members)
    # A file that also declares modules would redefine what the netlist defines.
    if members and all(member.kind == getattr(sv, "syntax", sv).SyntaxKind.PackageDeclaration for member in members):
        package_files.add(str(tree.sourceManager.getFullPath(tree.root.sourceRange.start.buffer)))
packages.write_text(json.dumps([name for name in sys.argv[3:] if name in package_files]))
