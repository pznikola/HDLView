#!/usr/bin/env python3
"""Qualify live diagnostics with real temporary projects and the configured tools."""
import argparse
import hashlib
import json
import pathlib
import subprocess
import tempfile
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", type=pathlib.Path, required=True)
    parser.add_argument("--store", type=pathlib.Path, default=pathlib.Path(".hdlview/lint-qualification"))
    args = parser.parse_args()
    profile = json.loads(args.profile.read_text())
    args.store.mkdir(parents=True, exist_ok=True)
    measurements = []
    with tempfile.TemporaryDirectory(prefix="hdlview lint qualification ") as temporary:
        root = pathlib.Path(temporary)
        rtl = root / "external rtl"
        rtl.mkdir()
        top = "`include \"defs.svh\"\nmodule top #(parameter W=`WIDTH)(input logic [W-1:0] a, output logic [W-1:0] y);\nassign y=a;\nendmodule\n"
        tb = "module tb; logic [3:0] a; wire [3:0] y; top dut(.a(a), .y(y)); initial a=`MODE; endmodule\n"
        (rtl / "top.sv").write_bytes(b"\xef\xbb\xbf" + top.replace("\n", "\r\n").encode())
        (rtl / "defs.svh").write_text("`define WIDTH 4\n")
        (rtl / "tb.sv").write_text(tb)
        (rtl / "orphan.SVH").write_text("`define UNUSED 1\n")
        (rtl / "unused.sv").write_text("not valid HDL  ")
        (rtl / "auxiliary.sv").write_text("not valid HDL  ")
        (root / "top.sv").write_text("module other; endmodule\n")
        config = root / "hdlview.project.json"
        reference = lambda path: dict(root="rtl", path=path)
        project = dict(schema_version=3, name="lint", top="top", standard="1800-2017",
                       source_roots=dict(rtl="external rtl"), sources=[dict(path=reference("top.sv"), language="system_verilog")],
                       headers=[reference("defs.svh"), reference("orphan.SVH")], include_dirs=[reference(".")],
                       simulation_sources=[reference("tb.sv")], parameters=dict(W="4"), assets=[reference("auxiliary.sv")],
                       simulations={name: dict(simulator="icarus", top="tb", dut_scope=["tb", "dut"], testbench=[reference("tb.sv")], defines=dict(MODE=value))
                                    for name, value in [("good", "1"), ("bad", "not_declared")]})
        config.write_text(json.dumps(project))
        originals = {file: file.read_bytes() for file in root.rglob("*") if file.is_file()}
        child = subprocess.Popen(["target/debug/hdlview", "--store", str(args.store.resolve()), "rpc"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)

        def rpc(action, value):
            child.stdin.write(json.dumps(dict(action=action, args=value)) + "\n")
            child.stdin.flush()
            response = json.loads(child.stdout.readline())
            if not response["ok"]:
                raise RuntimeError(response["error"])
            return response["result"]

        try:
            workspace = rpc("open_project", dict(path=str(config)))
            generation = 0

            def lint(label, buffers=None, active=None, context=None, style=True, tool_profile=None):
                nonlocal generation
                generation += 1
                start = time.monotonic()
                request = dict(path=workspace["path"], active_file=active or reference("top.sv"),
                               context=context or dict(kind="design"), buffers=[dict(file=reference(name), text=text, version=generation) for name, text in (buffers or {}).items()],
                               profile=tool_profile or profile, generation=generation, style=style)
                job = rpc("lint", request)
                while job["status"] == "running":
                    time.sleep(0.025)
                    job = rpc("job", dict(id=job["id"]))
                assert job["status"] == "complete", job
                result = job["result"]
                assert result["generation"] == generation
                for file, contents in originals.items():
                    assert file.read_bytes() == contents, file
                assert list((args.store / "editor-lint").iterdir()) == [args.store / "editor-lint/logs"]
                assert len([j for j in rpc("jobs", {}) if j["kind"] == "lint"]) == 1
                measurements.append(dict(case=label, milliseconds=round((time.monotonic() - start) * 1000, 1)))
                return result

            errors = lambda result: [d for d in result["diagnostics"] if d["severity"] == "error"]
            result = lint("valid BOM/CRLF inputs")
            assert not errors(result), result
            assert all(e["status"] == "complete" for e in result["engines"]), result
            edited = top.replace("assign y=a;", 'assign y=a; // é😀\nassign y=unknown;  ')
            result = lint("unsaved Unicode identifier and style diagnostics", {"top.sv": edited})
            diagnostic = next(d for d in errors(result) if "unknown" in d["message"])
            expected = len(edited[:edited.index("unknown")].encode("utf-16-le")) // 2
            assert diagnostic["from"] == expected and diagnostic["file"] == reference("top.sv"), diagnostic
            assert any(d["code"] == "no-trailing-spaces" for d in result["diagnostics"]), result
            assert next(f for f in result["files"] if f["file"] == reference("top.sv"))["text_hash"] == hashlib.sha256(edited.encode()).hexdigest()
            result = lint("unsaved syntax errors", {"top.sv": top.replace("assign y=a;", "assign y=;")})
            assert errors(result), result
            assert any(e["engine"] == "verible" and e["status"] == "limited" for e in result["engines"]), result
            result = lint("macro definition and expansion locations", {"defs.svh": "`define WIDTH 4\n`define VALUE unknown_macro\n", "top.sv": top.replace("assign y=a;", "assign y=`VALUE;")})
            diagnostic = next(d for d in errors(result) if "unknown_macro" in d["message"])
            assert diagnostic["file"] == reference("defs.svh"), diagnostic
            assert any(r.get("file") == reference("top.sv") for r in diagnostic["related"]), diagnostic
            rpc("update_project", dict(path=workspace["path"], project=dict(project, sources=project["sources"] + [dict(path="top.sv", language="system_verilog")])))
            result = lint("duplicate basenames remain separate", {"top.sv": edited})
            assert next(d for d in errors(result) if "unknown" in d["message"])["file"] == reference("top.sv"), result
            assert any(f["file"] == "top.sv" for f in result["files"]), result
            rpc("update_project", dict(path=workspace["path"], project=project))
            result = lint("width warnings", {"top.sv": top.replace("assign y=a;", "assign y=8'hff;")})
            assert any(d["engine"] == "slang" and d["code"] in ("width-trunc", "constant-conversion") for d in result["diagnostics"]), result
            result = lint("invalid ports", {"top.sv": top + "module parent; top child(.invalid(1)); endmodule\n"})
            # Use the invalid parent as the elaboration top, rather than an unused definition.
            changed = dict(project, top="parent")
            rpc("update_project", dict(path=workspace["path"], project=changed))
            result = lint("invalid elaborated ports", {"top.sv": top + "module parent; top child(.invalid(1)); endmodule\n"})
            assert errors(result), result
            rpc("update_project", dict(path=workspace["path"], project=project))
            result = lint("simultaneous header and design buffers", {"defs.svh": "`define WIDTH 8\n", "top.sv": top.replace("[W-1:0] a", "[7:0] a")})
            assert any("trunc" in d["message"] for d in result["diagnostics"]), result
            result = lint("included header context", active=reference("defs.svh"))
            assert not result["limited"], result
            result = lint("orphan header context", active=reference("orphan.SVH"))
            assert result["limited"] and not errors(result), result
            for name, expected_error in [("good", False), ("bad", True)]:
                result = lint(f"simulation context {name}", active=reference("tb.sv"), context=dict(kind="simulation", configuration=name))
                assert bool(errors(result)) == expected_error, result
                assert not any("W" in d["message"] and "parameter" in d["message"] for d in errors(result)), result
            result = lint("unconfigured simulation syntax checks", active=reference("tb.sv"), context=dict(kind="simulation", configuration=None))
            assert result["limited"], result
            rpc("update_project", dict(path=workspace["path"], project=dict(project, top="")))
            result = lint("missing top syntax checks", {"top.sv": top.replace("assign y=a;", "assign y=;")})
            assert result["limited"] and errors(result), result
            rpc("update_project", dict(path=workspace["path"], project=project))
            rules = root / ".rules.verible_lint"
            rules.write_text("+module-filename\n")
            result = lint("custom style preset replaces default", {"top.sv": top.replace("assign y=a;", "assign y=a;  ")})
            assert not any(d["code"] == "no-trailing-spaces" for d in result["diagnostics"]), result
            rules.write_text("+no-trailing-spaces\n")
            result = lint("style waiver", {"top.sv": top.replace("assign y=a;", "assign y=a;  // verilog_lint: waive no-trailing-spaces  ")})
            assert not any(d["code"] == "no-trailing-spaces" for d in result["diagnostics"]), result
            rules.write_text("+unknown-rule-for-qualification\n")
            result = lint("invalid style configuration")
            assert any(e["engine"] == "verible" and e["status"] == "failed" for e in result["engines"]), result
            assert not errors(result), result
            rules.unlink()
            unavailable = dict(profile, executables={**profile.get("executables", {}), "verible-verilog-lint": "/no/such/verible"})
            result = lint("missing style engine preserves semantic errors", {"top.sv": edited}, tool_profile=unavailable)
            assert errors(result) and result["limited"], result
            unavailable = dict(profile, executables={**profile.get("executables", {}), "python3": "/no/such/python"})
            result = lint("missing correctness engine preserves style warnings", {"top.sv": edited}, tool_profile=unavailable)
            assert any(e["engine"] == "slang" and e["status"] == "failed" for e in result["engines"]), result
            assert any(d["code"] == "no-trailing-spaces" for d in result["diagnostics"]), result
            result = lint("diagnostic publication is bounded", {"top.sv": top + "// trailing  \n" * 1010})
            assert result["truncated"] and len(result["diagnostics"]) == 1000, result
            result = lint("style disabled", style=False)
            assert any(e["status"] == "disabled" for e in result["engines"]), result
            for active, context in [("hdlview.project.json", dict(kind="design")), (reference("auxiliary.sv"), dict(kind="design")), (reference("tb.sv"), dict(kind="simulation", configuration="missing"))]:
                try:
                    rpc("lint", dict(path=workspace["path"], active_file=active, context=context, buffers=[], profile=profile, generation=999, style=False))
                except RuntimeError:
                    pass
                else:
                    raise AssertionError("Invalid lint request was accepted")
            result = lint("correction without saving", {"top.sv": top})
            assert not errors(result), result
            print(json.dumps(measurements, indent=2))
            (args.store / "results.json").write_text(json.dumps(dict(profile=args.profile.as_posix(), cases=measurements), indent=2))
        finally:
            child.terminate()
            child.wait(timeout=5)


if __name__ == "__main__":
    main()
