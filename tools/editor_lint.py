#!/usr/bin/env python3
"""Return compiler diagnostics for captured working buffers, including invalid HDL."""
import json
import pathlib
import shlex
import sys
from importlib.metadata import version


def analyze(request):
    installed = version("pyslang")
    if installed.split(".")[0] not in ("10", "11"):
        raise RuntimeError(
            f"Live linting requires pyslang 10 or 11; configured Python has {installed}. "
            "Select the qualified IIC-OSIC-TOOLS image in Toolchain, or install "
            "pyslang==11.0.0 into the configured native Python environment."
        )
    import pyslang as sv

    # pyslang 11 moved Driver into a submodule.
    driver = getattr(sv, "driver", sv).Driver()
    driver.addStandardArgs()
    driver.diagEngine.clearClients()
    args = ["--std", request["standard"], "-Wextra"]
    if request["top"]:
        args += ["--top", request["top"]]
    for directory in request["include_dirs"]:
        args += ["-I", directory]
    for key, value in request["defines"].items():
        args += ["-D", f"{key}={value}"]
    for key, value in request["parameters"].items():
        args += ["-G", f"{key}={value}"]
    args += request["files"]
    if not driver.parseCommandLine("slang " + shlex.join(args)) or not driver.processOptions():
        raise RuntimeError("Invalid compiler options or missing lint inputs")
    driver.parseAllSources()
    engine = driver.diagEngine
    manager = driver.sourceManager
    diagnostics = list(engine.setMappingsFromPragmas())
    if request["top"]:
        compilation = driver.createCompilation()
        diagnostics += list(compilation.getAllDiagnostics())
        if not any(d.isError() for d in diagnostics):
            diagnostics += list(driver.runAnalysis(compilation).getDiagnostics())
    else:
        for tree in driver.syntaxTrees:
            diagnostics += list(tree.diagnostics)

    def location(loc):
        if loc == sv.SourceLocation.NoLocation:
            return None
        loc = manager.getFullyOriginalLoc(loc)
        return dict(file=str(manager.getFullPath(loc.buffer)), offset=loc.offset)

    output = []
    for diagnostic in diagnostics:
        severity = str(engine.getSeverity(diagnostic.code, diagnostic.location)).split(".")[-1].lower()
        if severity == "ignored":
            continue
        loc = location(diagnostic.location)
        spans = []
        for span in diagnostic.ranges:
            start, end = location(span.start), location(span.end)
            if start and end and start["file"] == end["file"]:
                spans.append(dict(file=start["file"], start=start["offset"], end=end["offset"]))
        output.append(dict(
            severity="error" if severity == "fatal" else severity,
            code=engine.getOptionName(diagnostic.code) or str(diagnostic.code),
            message=engine.formatMessage(diagnostic),
            location=loc,
            ranges=spans,
            related=[],
        ))
        expansion = diagnostic.location
        for _ in range(32):
            if not manager.isMacroLoc(expansion):
                break
            name = manager.getMacroName(expansion)
            expansion = manager.getExpansionLoc(expansion)
            output[-1]["related"].append(dict(
                location=location(expansion), message=f"Expanded from macro '{name}'",
            ))
    files = []
    for buffer in manager.getAllBuffers():
        path = str(manager.getFullPath(buffer))
        if path:
            files.append(path)
    return dict(diagnostics=output, files=sorted(set(files)))


def main():
    request, output = map(pathlib.Path, sys.argv[1:])
    result = analyze(json.loads(request.read_text()))
    output.write_text(json.dumps(result))


if __name__ == "__main__":
    main()
