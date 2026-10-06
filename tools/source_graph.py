#!/usr/bin/env python3
"""Isolated semantic frontend. No regex-based HDL parsing or synthesis recovery."""
import json
import pathlib
import shlex
import sys


def empty_module(name):
    return dict(name=name, ports=[], signals=[], cells=[], blackbox=False)


def port(name, direction, bits):
    return dict(name=name, direction=direction, bits=bits)


def cell(name, kind, ports, source=None, **attributes):
    return dict(name=name, kind=kind, ports=ports, source=source, attributes=attributes)


def systemverilog(project, root):
    import pyslang as sv
    driver = sv.Driver()
    driver.addStandardArgs()
    args = ["--top", project["top"], "--std", project.get("standard", "1800-2017")]
    for directory in project.get("include_dirs", []):
        args += ["-I", str(root / directory)]
    for key, value in project.get("defines", {}).items():
        args += ["-D", f"{key}={value}"]
    for key, value in project.get("parameters", {}).items():
        args += ["-G", f"{key}={value}"]
    args += [str(root / s["path"]) for s in project["sources"]]
    if not driver.parseCommandLine("slang " + shlex.join(args)) or not driver.processOptions() or not driver.parseAllSources():
        raise RuntimeError("Slang source parsing failed")
    compilation = driver.createCompilation()
    compilation.getRoot()
    driver.reportCompilation(compilation, False)
    if compilation.hasIssuedErrors:
        driver.reportDiagnostics(False)
        raise RuntimeError("Slang semantic analysis failed")
    modules, diagnostics = {}, []
    manager = driver.sourceManager

    def location(node):
        loc = getattr(node, "location", None)
        if loc is None and hasattr(node, "sourceRange"):
            loc = node.sourceRange.start
        if loc is None:
            return None
        try:
            return f"{manager.getFileName(loc)}:{manager.getLineNumber(loc)}:{manager.getColumnNumber(loc)}"
        except (ValueError, RuntimeError):
            return None

    def references(node):
        names = set()
        if node is not None:
            def visit(n):
                if isinstance(n, sv.NamedValueExpression):
                    names.add(n.symbol.name)
            node.visit(visit)
        return names

    def assigned_names(expression):
        if isinstance(expression, sv.NamedValueExpression):
            return {expression.symbol.name}
        kind = type(expression).__name__
        if kind in ("ElementSelectExpression", "RangeSelectExpression", "MemberAccessExpression"):
            return assigned_names(expression.value)
        if kind == "ConcatenationExpression":
            return set().union(*(assigned_names(item) for item in expression.operands))
        diagnostics.append(dict(severity="warning", message=f"Opaque assignment target: {kind}", source=location(expression)))
        return set()

    def build(instance, module_name):
        m = empty_module(module_name)
        modules[module_name] = m
        body = instance.body
        wires, nextbit = {}, 2
        for n in body:
            if isinstance(n, (sv.NetSymbol, sv.VariableSymbol)):
                width = int(n.type.bitWidth)
                if width <= 0 or width > 65536:
                    diagnostics.append(dict(severity="warning", message=f"Opaque non-integral/large signal {n.name}", source=location(n)))
                    continue
                r = n.type.getBitVectorRange()
                wires[n.name] = list(range(nextbit, nextbit + width))
                nextbit += width
                m["signals"].append(dict(name=n.name, bits=wires[n.name], offset=min(r.left, r.right), upto=r.left < r.right, signed=n.type.isSigned, source=location(n)))
        for p in body.portList:
            m["ports"].append(port(p.name, {"in":"input","out":"output","inout":"inout","ref":"inout"}[str(p.direction).split(".")[-1].lower()], wires.get(p.name, [])))

        def dependency_ports(reads, writes):
            return [port(n, "input", wires[n]) for n in sorted(reads) if n in wires] + [port(n + " (write)", "output", wires[n]) for n in sorted(writes) if n in wires]

        for i, n in enumerate(body):
            if isinstance(n, sv.InstanceSymbol):
                child = module_name + "/" + n.name
                build(n, child)
                ps = []
                for conn in n.portConnections:
                    direction = {"in":"input","out":"output","inout":"inout","ref":"inout"}[str(conn.port.direction).split(".")[-1].lower()]
                    refs = references(conn.expression)
                    # Source connections are dependencies, not bit-accurate electrical wiring.
                    ps.append(port(conn.port.name, direction, [b for name in sorted(refs) for b in wires.get(name, [])]))
                m["cells"].append(cell(n.name, child, ps, location(n)))
            elif isinstance(n, (sv.ProceduralBlockSymbol, sv.ContinuousAssignSymbol)):
                reads, writes, operators, assignments = set(), set(), [], []
                def visit(x):
                    if isinstance(x, sv.AssignmentExpression):
                        targets = assigned_names(x.left)
                        writes.update(targets)
                        reads.update(references(x.right))
                        reads.update(references(x.left) - targets)
                        if getattr(x, "isCompound", False) is True: reads.update(targets)
                        assignments.append(str(x.syntax) if x.syntax else str(x.kind))
                        # Read dynamic select indices on the LHS conservatively.
                        return sv.VisitAction.Skip
                    if isinstance(x, sv.NamedValueExpression):
                        reads.add(x.symbol.name)
                    return sv.VisitAction.Advance
                n.visit(visit)
                def opvisit(x):
                    if isinstance(x, (sv.BinaryExpression, sv.UnaryExpression)):
                        operators.append(dict(kind=str(x.op), source=location(x), expression=str(x.syntax) if x.syntax else ""))
                n.visit(opvisit)
                kind = str(n.procedureKind).split(".")[-1] if isinstance(n, sv.ProceduralBlockSymbol) else "assign"
                m["cells"].append(cell(n.name or f"{kind}_{i}", kind, dependency_ports(reads, writes), location(n), operators=operators, assignments=assignments, source_text=str(n.syntax) if n.syntax else "", edge_semantics="source_dependencies"))
            elif str(n.kind).split(".")[-1] in ("GenerateBlock", "GenerateBlockArray", "InstanceArray"):
                diagnostics.append(dict(severity="warning", message=f"Source generate/instance array {n.name} shown as opaque; use elaborated RTL for resolved connectivity", source=location(n)))
                m["cells"].append(cell(n.name or f"generate_{i}", "opaque generate", [], location(n), source_text=str(n.syntax)))
        return m

    tops = compilation.getRoot().topInstances
    selected = next((i for i in tops if i.name == project["top"]), None)
    if selected is None:
        raise RuntimeError("Slang did not elaborate the selected top")
    build(selected, project["top"])
    return dict(design=dict(modules=modules, scopes=[]), diagnostics=diagnostics)


def main():
    project_path, root, output = map(pathlib.Path, sys.argv[1:])
    project = json.loads(project_path.read_text())
    result = systemverilog(project,root)
    output.write_text(json.dumps(result,indent=2))


if __name__ == "__main__":
    main()
