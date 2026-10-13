"""Extract blackbox module ports using Slang; retain exact model declarations."""
import pathlib
import shlex
import sys
import pyslang as sv
output = pathlib.Path(sys.argv[1])
# pyslang 11 moved Driver into a submodule.
driver = getattr(sv, "driver", sv).Driver()
driver.addStandardArgs()
args = ["-D", "FUNCTIONAL"]
for filename in sys.argv[2:]:
    args.extend(["-I", str(pathlib.Path(filename).parent), filename])
if not driver.parseCommandLine("slang " + shlex.join(args)) or not driver.processOptions() or not driver.parseAllSources():
    raise RuntimeError("Could not parse standard-cell simulation models")
compilation = driver.createCompilation()
root = compilation.getRoot()
if compilation.hasIssuedErrors:
    driver.reportDiagnostics(False)
    raise RuntimeError("Invalid standard-cell simulation models")
def identifier(name):
    return "\\" + name + " "
lines = []
for instance in root.topInstances:
    ports = instance.body.portList
    name = instance.body.definition.name
    lines.append(f"(* blackbox *) module {identifier(name)}({', '.join(identifier(p.name) for p in ports)});")
    for port in ports:
        direction = {"in": "input", "out": "output", "inout": "inout"}[str(port.direction).split(".")[-1].lower()]
        vector = port.type.getBitVectorRange()
        width = f"[{vector.left}:{vector.right}] " if port.type.bitWidth > 1 else ""
        lines.append(f"  {direction} {width}{identifier(port.name)};")
    lines.append("endmodule")
output.write_text("\n".join(lines) + "\n")
