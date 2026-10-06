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
    # pyslang 9 exposes the API at the package root; later versions use submodules.
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


def vhdl(project, root):
    from pyGHDL.dom.NonStandard import Design, Document
    from pyVHDLModel import VHDLVersion
    design = Design()
    standard = str(project.get("standard", "08"))
    year = {"87":1987, "93":1993, "93c":1993, "00":2000, "02":2002, "08":2008, "19":2019}.get(standard)
    if year is None: raise RuntimeError(f"Unsupported VHDL standard: {standard}")
    version = getattr(VHDLVersion, f"VHDL{year}")
    def name_key(name): return name if name.startswith("\\") else name.lower()
    docs = []
    for entry in project["sources"]:
        document = Document(root / entry["path"], vhdlVersion=version)
        design.AddDocument(document, design.GetLibrary(entry.get("library") or "work"))
        docs.append(document)
    modules, diagnostics = {}, []

    def loc(obj):
        p = getattr(obj, "Position", None)
        return f"{p.Filename}:{p.Line}:{p.Column}" if p else None

    # Walk the DOM's public child properties; never walk parent/design backlinks.
    def children(obj):
        for key in ("LeftOperand", "RightOperand", "Operand", "Expression", "Condition", "Conditions", "Statements", "IfBranch", "ElsIfBranches", "ElseBranch", "Cases", "Choices", "Waveform", "WaveformElements", "Value", "Parameters", "Associations", "Actual", "Prefix", "Name", "SensitivityList", "Target", "WhenBranches", "PortAssociations", "GenericAssociations"):
            try:
                value = getattr(obj, key, None)
            except (AttributeError, NotImplementedError):
                continue
            if isinstance(value, (list, tuple)):
                yield from value
            elif value is not None and not isinstance(value, (str, int, float, bool)):
                yield value

    def walk(obj, seen=None):
        seen = set() if seen is None else seen
        if obj is None or id(obj) in seen:
            return
        seen.add(id(obj))
        yield obj
        for child in children(obj):
            yield from walk(child, seen)

    def refs(obj, names):
        found = set()
        for item in walk(obj):
            name = getattr(item, "Identifier", None)
            if isinstance(name, str) and name_key(name) in names:
                found.add(name_key(name))
        return found

    entities, architectures = {}, {}
    for doc in docs:
        for name, entity in doc.Entities.items():
            if name_key(name) in entities:
                raise RuntimeError(f"Duplicate source entity {name} across libraries needs explicit configuration")
            entities[name_key(name)] = entity
        for name, by_architecture in doc.Architectures.items():
            if len(by_architecture) != 1:
                raise RuntimeError(f"Select a project with one architecture for source entity {name}")
            architectures[name.lower()] = next(iter(by_architecture.values()))
    def evaluate(obj, values):
        if obj is None:
            return None
        value = getattr(obj, "Value", None)
        if isinstance(value, int):
            return value
        identifier = getattr(obj, "Identifier", None)
        if isinstance(identifier, str):
            return values.get(identifier.lower())
        if hasattr(obj, "Name"):
            return evaluate(obj.Name, values)
        left = evaluate(getattr(obj, "LeftOperand", None), values)
        right = evaluate(getattr(obj, "RightOperand", None), values)
        kind = type(obj).__name__
        if left is not None and right is not None:
            if kind == "AdditionExpression": return left + right
            if kind == "SubtractionExpression": return left - right
            if kind == "MultiplyExpression": return left * right
        return None

    def build(name, module_name, overrides=None, ancestors=()):
        if name in ancestors:
            raise RuntimeError(f"Recursive source hierarchy: {name}")
        entity = entities[name]
        values = {}
        for generic in entity.GenericItems:
            for identifier in generic.Identifiers:
                values[identifier.lower()] = evaluate(generic.DefaultExpression, values)
        values.update(overrides or {})
        m = empty_module(module_name)
        modules[module_name] = m
        wires, nextbit = {}, 2
        architecture = architectures.get(name)
        declarations = list(entity.PortItems) + (list(architecture.DeclaredItems) if architecture else [])
        for declaration in declarations:
            identifiers = getattr(declaration, "Identifiers", [])
            if "Signal" not in type(declaration).__name__:
                continue
            subtype = getattr(declaration, "Subtype", None)
            width, offset, upto = 1, 0, False
            constraints = getattr(subtype, "Constraints", []) or []
            if constraints:
                bounds = constraints[0]
                left = evaluate(getattr(bounds, "LeftOperand", None), values)
                right = evaluate(getattr(bounds, "RightOperand", None), values)
                if isinstance(left, int) and isinstance(right, int):
                    width, offset, upto = abs(left-right)+1, min(left,right), left<right
                else:
                    diagnostics.append(dict(severity="warning", message=f"Unresolved source range for {identifiers}; signal binding disabled", source=loc(declaration)))
                    width = 0
            else:
                type_name = getattr(getattr(subtype, "Name", None), "Identifier", "").lower()
                if type_name not in ("std_logic", "std_ulogic", "bit", "boolean"):
                    width = 0
                    diagnostics.append(dict(severity="warning",message=f"Opaque source type {type_name} for {identifiers}",source=loc(declaration)))
            for identifier in identifiers:
                n = name_key(identifier)
                wires[n] = list(range(nextbit, nextbit+width))
                nextbit += width
                m["signals"].append(dict(name=n,bits=wires[n],offset=offset,upto=upto,source=loc(declaration)))
                if declaration in entity.PortItems:
                    direction = str(declaration.Mode).split(".")[-1].lower()
                    direction = {"in":"input", "out":"output", "buffer":"output"}.get(direction,"inout")
                    m["ports"].append(port(n,direction,wires[n]))
        if architecture:
            for i, statement in enumerate(architecture.Statements):
                label = getattr(statement,"Label",None) or f"statement_{i}"
                kind = type(statement).__name__
                if kind in ("EntityInstantiation", "ComponentInstantiation"):
                    symbol = getattr(statement, "Entity", None)
                    if symbol is None: symbol = getattr(statement, "Component", None)
                    identifier = getattr(getattr(symbol, "Name", None), "Identifier", "").lower()
                    if identifier in entities:
                        child_name = module_name + "/" + label
                        generic_values = {}
                        for index, association in enumerate(statement.GenericAssociations):
                            formal = getattr(association.Formal, "Identifier", None)
                            if formal is None:
                                formal = entities[identifier].GenericItems[index].Identifiers[0]
                            generic_values[formal.lower()] = evaluate(association.Actual, values)
                        child = build(identifier, child_name, generic_values, (*ancestors, name))
                        ps = []
                        for index, association in enumerate(statement.PortAssociations):
                            formal = getattr(association.Formal, "Identifier", None)
                            definition = next((p for p in child["ports"] if p["name"] == formal.lower()), None) if formal else child["ports"][index]
                            if definition:
                                ps.append(port(definition["name"], definition["direction"], [b for n in sorted(refs(association.Actual, wires)) for b in wires[n]]))
                        m["cells"].append(cell(label, child_name, ps, loc(statement), generics=generic_values, edge_semantics="source_dependencies"))
                        continue
                reads = refs(statement,wires)
                writes = set()
                for item in walk(statement):
                    target = getattr(item,"Target",None)
                    if target is not None:
                        writes.update(refs(target,wires))
                # Separate write targets from reads; explicitly restore feedback reads from RHS.
                reads -= writes
                for item in walk(statement):
                    for key in ("Expression","Waveform","WaveformElements","Condition"):
                        value=getattr(item,key,None)
                        if isinstance(value,(list,tuple)):
                            for v in value: reads.update(refs(v,wires))
                        elif value is not None: reads.update(refs(value,wires))
                ps=[port(n,"input",wires[n]) for n in sorted(reads)]+[port(n+" (write)","output",wires[n]) for n in sorted(writes)]
                m["cells"].append(cell(label,kind,ps,loc(statement),source_text=f"{kind} at {loc(statement)}",edge_semantics="source_dependencies"))
                if not ("Process" in kind or "Assignment" in kind):
                    diagnostics.append(dict(severity="warning",message=f"Opaque source construct {kind}: {label}",source=loc(statement)))
        return m
    top = project["top"].lower()
    if top not in entities:
        raise RuntimeError("VHDL source top not found")
    parameters = {k.lower(): int(v) if str(v).lstrip("-").isdigit() else None for k, v in project.get("parameters", {}).items()}
    build(top, project["top"], parameters)
    return dict(design=dict(modules=modules,scopes=[]),diagnostics=diagnostics)


def main():
    project_path, root, output = map(pathlib.Path, sys.argv[1:])
    project = json.loads(project_path.read_text())
    result = vhdl(project,root) if project["sources"][0]["language"] == "vhdl" else systemverilog(project,root)
    output.write_text(json.dumps(result,indent=2))


if __name__ == "__main__":
    main()
