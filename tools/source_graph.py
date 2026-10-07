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

    def references(node, symbols=None):
        names = set()
        if node is not None:
            def visit(n):
                if isinstance(n, sv.NamedValueExpression):
                    if symbols is None or n.symbol.hierarchicalPath in symbols:
                        names.add(n.symbol.name)
            node.visit(visit)
        return names

    def assigned_names(expression, symbols=None):
        if isinstance(expression, sv.NamedValueExpression):
            return {expression.symbol.name} if symbols is None or expression.symbol.hierarchicalPath in symbols else set()
        kind = type(expression).__name__
        if kind in ("ElementSelectExpression", "RangeSelectExpression", "MemberAccessExpression"):
            return assigned_names(expression.value, symbols)
        if kind == "ConcatenationExpression":
            return set().union(*(assigned_names(item, symbols) for item in expression.operands))
        diagnostics.append(dict(severity="warning", message=f"Opaque assignment target: {kind}", source=location(expression)))
        return set()

    def capture_behavior(root_node, module_symbols):
        nodes, edges = [], []
        symbols = {n.hierarchicalPath: n.name for n in module_symbols}
        limit_node = None

        def bound_signals(node):
            names = set()
            if node is not None:
                def visit(n):
                    if isinstance(n, sv.NamedValueExpression):
                        name = symbols.get(n.symbol.hierarchicalPath)
                        if name:
                            names.add(name)
                node.visit(visit)
            return sorted(names)

        def span(node):
            source_range = getattr(node, "sourceRange", None)
            if source_range is None:
                syntax = getattr(node, "syntax", None)
                source_range = getattr(syntax, "sourceRange", None)
            if source_range is None:
                return None
            try:
                start, end = source_range.start, source_range.end
                return dict(file=str(manager.getFileName(start)),
                            start=[manager.getLineNumber(start), manager.getColumnNumber(start)],
                            end=[manager.getLineNumber(end), manager.getColumnNumber(end)])
            except (ValueError, RuntimeError):
                return None

        def add(node, kind, label, call=None, signals=None):
            nonlocal limit_node
            if len(nodes) >= 8000:
                if limit_node is None:
                    limit_node = str(len(nodes))
                    nodes.append(dict(id=limit_node, kind="opaque", label="behavior capture limit",
                                      signals=[], source=location(node)))
                    diagnostics.append(dict(severity="warning", message="Source behavior capture limited to 8000 nodes", source=location(node)))
                return limit_node
            identity = str(len(nodes))
            nodes.append(dict(id=identity, kind=kind, label=label, signals=bound_signals(node) if signals is None else signals,
                              source=location(node), span=span(node), call=call,
                              width=int(node.type.bitWidth) if hasattr(node, "type") and node.type.bitWidth > 0 else None,
                              signed=node.type.isSigned if hasattr(node, "type") and node.type.bitWidth > 0 else None))
            return identity

        def connect(source, target, label="", semantics="dependency"):
            if source is not None and target is not None:
                edges.append(dict(source=source, target=target, label=label, semantics=semantics))

        operators = {
            "Add": "+", "Subtract": "−", "Multiply": "×", "Divide": "÷", "Mod": "%",
            "BinaryAnd": "&", "BinaryOr": "|", "BinaryXor": "^", "BinaryXnor": "~^",
            "LogicalAnd": "&&", "LogicalOr": "||", "LogicalNot": "!", "BitwiseNot": "~",
            "Equality": "==", "Inequality": "!=", "CaseEquality": "===", "CaseInequality": "!==",
            "LessThan": "<", "LessThanEqual": "≤", "GreaterThan": ">", "GreaterThanEqual": "≥",
            "LogicalShiftLeft": "≪", "LogicalShiftRight": "≫", "ArithmeticShiftRight": ">>>",
        }

        def expression(node, depth=0):
            if node is None:
                return None
            if depth > 96 or len(nodes) >= 8000:
                return add(node, "opaque", "expression limit")
            kind = type(node).__name__
            text = str(node.syntax).strip() if node.syntax else kind
            operands = []
            if isinstance(node, sv.NamedValueExpression):
                return add(node, "reference", node.symbol.name)
            if kind in ("IntegerLiteral", "UnbasedUnsizedIntegerLiteral", "RealLiteral", "StringLiteral"):
                return add(node, "constant", text)
            if kind == "ConversionExpression":
                result = add(node, "operator", str(node.type))
                operands = [node.operand]
            elif isinstance(node, (sv.BinaryExpression, sv.UnaryExpression)):
                op = str(node.op).split(".")[-1]
                symbol = {"BinaryAnd": "and", "LogicalAnd": "and", "BinaryOr": "or", "LogicalOr": "or",
                          "BinaryXor": "xor", "BitwiseNot": "not", "LogicalNot": "not"}.get(op, "operator")
                result = add(node, symbol, operators.get(op, op))
                operands = [node.left, node.right] if isinstance(node, sv.BinaryExpression) else [node.operand]
            elif kind == "ConditionalExpression":
                result = add(node, "mux", "?:")
                for condition in node.conditions:
                    connect(expression(condition.expr, depth + 1), result, "select")
                operands = [node.right, node.left]
            elif kind in ("ConcatenationExpression", "ReplicationExpression"):
                result = add(node, "operator", "concat" if kind == "ConcatenationExpression" else "repeat")
                operands = list(node.operands) if kind == "ConcatenationExpression" else [node.count, node.concat]
            elif kind in ("ElementSelectExpression", "RangeSelectExpression", "MemberAccessExpression"):
                result = add(node, "operator", text)
                operands = [node.value]
                if kind == "ElementSelectExpression": operands.append(node.selector)
                elif kind == "RangeSelectExpression": operands += [node.left, node.right]
            elif kind == "CallExpression":
                name = node.subroutineName
                target_kind = str(node.subroutineKind).split(".")[-1].lower()
                result = add(node, "task" if target_kind == "task" else "function", name, name if not node.isSystemCall else None)
                operands = list(node.arguments)
            elif isinstance(node, sv.AssignmentExpression):
                operator = "<=" if node.isNonBlocking else "="
                if node.isCompound: operator = str(node.op).split(".")[-1] + "="
                target = str(node.left.syntax).strip() if node.left.syntax else "target"
                result = add(node, "assignment", f"{target} {operator}", signals=sorted(assigned_names(node.left, symbols)))
                operands = [node.right]
                if type(node.left).__name__ in ("ElementSelectExpression", "RangeSelectExpression"):
                    connect(expression(node.left, depth + 1), result, "target")
                if node.isCompound:
                    connect(expression(node.left, depth + 1), result, "previous value")
                if node.timingControl is not None:
                    connect(timing(node.timingControl, depth + 1), result, "assignment timing", "control_flow")
            else:
                diagnostics.append(dict(severity="warning", message=f"Opaque source expression: {kind}", source=location(node)))
                return add(node, "opaque", text)
            for index, operand in enumerate(operands):
                connect(expression(operand, depth + 1), result, str(index))
            return result

        def timing(control, depth=0):
            text = str(control.syntax).strip() if control.syntax else str(control.kind)
            result = add(control, "event", text)
            if hasattr(control, "expr"):
                label = str(control.edge).split(".")[-1] if hasattr(control, "edge") else "delay"
                connect(expression(control.expr, depth + 1), result, label)
            if hasattr(control, "iffCondition"):
                connect(expression(control.iffCondition, depth + 1), result, "iff")
            for event in getattr(control, "events", []):
                connect(timing(event, depth + 1), result, "event")
            return result

        def statement(node, depth=0):
            if node is None:
                return None, []
            if depth > 96 or len(nodes) >= 8000:
                result = add(node, "opaque", "statement limit")
                return result, [result]
            kind = type(node).__name__
            if kind == "BlockStatement":
                entry = add(node, "block", str(node.blockKind).split(".")[-1])
                child, exits = statement(node.body, depth + 1)
                connect(entry, child, "body", "control_flow")
                return entry, exits if child is not None else [entry]
            if kind == "StatementList":
                first, previous = None, []
                for item in node.list:
                    entry, exits = statement(item, depth + 1)
                    if first is None: first = entry
                    for last in previous: connect(last, entry, "next", "control_flow")
                    previous = exits
                return first, previous
            if kind == "VariableDeclStatement":
                result = add(node, "assignment", f"declare {node.symbol.name}", signals=[])
                connect(expression(node.symbol.initializer, depth + 1), result, "initialize")
                return result, [result]
            if kind == "ExpressionStatement":
                result = expression(node.expr, depth + 1)
                return result, [result] if result is not None else []
            if kind == "TimedStatement":
                result = timing(node.timing, depth + 1)
                entry, exits = statement(node.stmt, depth + 1)
                connect(result, entry, "event", "control_flow")
                return result, exits if entry is not None else [result]
            if kind == "ConditionalStatement":
                result = add(node, "if", "if")
                for condition in node.conditions:
                    connect(expression(condition.expr, depth + 1), result, "condition")
                join = add(node, "merge", "end if", signals=[])
                for child, label in [(node.ifTrue, "then"), (node.ifFalse, "else")]:
                    entry, branch_exits = statement(child, depth + 1)
                    connect(result, entry if entry is not None else join, label, "control_flow")
                    for last in branch_exits: connect(last, join, label, "control_flow")
                return result, [join]
            if kind == "CaseStatement":
                result = add(node, "case", str(node.condition).split(".")[-1] + " case")
                connect(expression(node.expr, depth + 1), result, "selector")
                join = add(node, "merge", "end case", signals=[])
                for item in node.items:
                    entry, branch_exits = statement(item.stmt, depth + 1)
                    label = ", ".join(str(x.syntax).strip() if x.syntax else str(x.kind) for x in item.expressions)
                    connect(result, entry, label, "control_flow")
                    for last in branch_exits: connect(last, join, "case exit", "control_flow")
                entry, branch_exits = statement(node.defaultCase, depth + 1)
                connect(result, entry if entry is not None else join, "default" if node.defaultCase is not None else "no match", "control_flow")
                for last in branch_exits: connect(last, join, "default exit", "control_flow")
                return result, [join]
            if kind in ("ForLoopStatement", "WhileLoopStatement", "DoWhileLoopStatement", "RepeatLoopStatement", "ForeverLoopStatement"):
                result = add(node, "loop", kind.removesuffix("Statement"))
                for init in getattr(node, "initializers", []):
                    connect(expression(init, depth + 1), result, "initialize")
                condition = getattr(node, "stopExpr", None) or getattr(node, "cond", None) or getattr(node, "count", None)
                connect(expression(condition, depth + 1), result, "condition")
                entry, exits = statement(node.body, depth + 1)
                if kind == "DoWhileLoopStatement":
                    for last in exits: connect(last, result, "condition", "control_flow")
                    connect(result, entry, "repeat if true", "control_flow")
                    return entry, [result]
                connect(result, entry, "body", "control_flow")
                previous = exits
                for step in getattr(node, "steps", []):
                    target = expression(step, depth + 1)
                    for last in previous: connect(last, target, "step", "control_flow")
                    previous = [target] if target is not None else []
                for last in previous: connect(last, result, "repeat", "control_flow")
                return result, [result]
            if kind == "ReturnStatement":
                result = add(node, "return", "return")
                connect(expression(node.expr, depth + 1), result, "value")
                return result, []
            if kind == "EmptyStatement":
                result = add(node, "block", ";")
                return result, [result]
            text = str(node.syntax).strip() if node.syntax else kind
            diagnostics.append(dict(severity="warning", message=f"Opaque source statement: {kind}", source=location(node)))
            result = add(node, "opaque", text)
            return result, [result]

        if isinstance(root_node, sv.ContinuousAssignSymbol):
            expression(root_node.assignment)
        else:
            statement(root_node.body)
        return dict(nodes=nodes, edges=edges)

    def build(instance, module_name):
        m = empty_module(module_name)
        modules[module_name] = m
        body = instance.body
        wires, nextbit = {}, 2
        module_symbols = [n for n in body if isinstance(n, (sv.NetSymbol, sv.VariableSymbol))]
        symbols = {n.hierarchicalPath for n in module_symbols}
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
                    refs = references(conn.expression, symbols)
                    # Source connections are dependencies, not bit-accurate electrical wiring.
                    ps.append(port(conn.port.name, direction, [b for name in sorted(refs) for b in wires.get(name, [])]))
                m["cells"].append(cell(n.name, child, ps, location(n)))
            elif isinstance(n, (sv.ProceduralBlockSymbol, sv.ContinuousAssignSymbol, sv.SubroutineSymbol)):
                reads, writes, operators, assignments = set(), set(), [], []
                def visit(x):
                    if isinstance(x, sv.AssignmentExpression):
                        targets = assigned_names(x.left, symbols)
                        writes.update(targets)
                        reads.update(references(x.right, symbols))
                        reads.update(references(x.left, symbols) - targets)
                        if getattr(x, "isCompound", False) is True: reads.update(targets)
                        assignments.append(str(x.syntax) if x.syntax else str(x.kind))
                        # Read dynamic select indices on the LHS conservatively.
                        return sv.VisitAction.Skip
                    if isinstance(x, sv.NamedValueExpression):
                        if x.symbol.hierarchicalPath in symbols:
                            reads.add(x.symbol.name)
                    return sv.VisitAction.Advance
                n.visit(visit)
                def opvisit(x):
                    if isinstance(x, (sv.BinaryExpression, sv.UnaryExpression)):
                        operators.append(dict(kind=str(x.op), source=location(x), expression=str(x.syntax) if x.syntax else ""))
                n.visit(opvisit)
                kind = (str(n.procedureKind).split(".")[-1] if isinstance(n, sv.ProceduralBlockSymbol)
                        else str(n.subroutineKind).split(".")[-1].lower() if isinstance(n, sv.SubroutineSymbol)
                        else "assign")
                captured = cell(n.name or f"{kind}_{i}", kind, dependency_ports(reads, writes), location(n),
                                operators=operators, assignments=assignments,
                                source_text=str(n.syntax) if n.syntax else "", edge_semantics="source_dependencies")
                if isinstance(n, sv.SubroutineSymbol):
                    widths = {}
                    for argument in n.arguments:
                        name = "argument " + argument.name
                        direction = {"in": "input", "out": "output", "inout": "inout", "ref": "inout"}[str(argument.direction).split(".")[-1].lower()]
                        captured["ports"].append(port(name, direction, []))
                        widths[name] = int(argument.type.bitWidth)
                    if n.returnType.bitWidth > 0:
                        captured["ports"].append(port("return", "output", []))
                        widths["return"] = int(n.returnType.bitWidth)
                    captured["attributes"]["formal_widths"] = widths
                captured["behavior"] = capture_behavior(n, module_symbols)
                m["cells"].append(captured)
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
