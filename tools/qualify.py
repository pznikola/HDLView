#!/usr/bin/env python3
"""Reproduce shared-testbench workflows; physical failed_checks remain distinct."""
import argparse
import json
import os
import pathlib
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument("--profile", required=True)
parser.add_argument("--store", default=".hdlview/qualification")
parser.add_argument("--mapped", action="store_true")
parser.add_argument("--physical", action="store_true")
parser.add_argument("--schematics", action="store_true", help="qualify symbols and captured behavior")
args = parser.parse_args()
store = pathlib.Path(args.store)
store.mkdir(parents=True, exist_ok=True)
records = []


def run(arguments, label):
    start = time.monotonic()
    result = subprocess.run(
        ["target/debug/hdlview", "--store", str(store), "--profile", args.profile, *arguments],
        capture_output=True, text=True,
    )
    record = dict(case=label, seconds=time.monotonic() - start,
                  exit_code=result.returncode, error=result.stderr)
    value = json.loads(result.stdout) if result.returncode == 0 else None
    if value and "directory" in value:
        record["directory"] = value["directory"]
    if value and value.get("physical_run"):
        record["physical_status"] = value["physical_run"]["status"]
    records.append(record)
    (store / "results.json").write_text(json.dumps(records, indent=2))
    print(label, result.returncode, record.get("physical_status", ""), flush=True)
    return value


projects = [(name, pathlib.Path(f"tests/fixtures/{name}/hdlview.project.json"),
             ["source", "elaborated", "generic"]) for name in (["counter", "verilog", "schematic"] if args.schematics else ["counter", "verilog"])]
if args.mapped or args.physical:
    original = pathlib.Path("tests/fixtures/counter/hdlview.project.json")
    for technology, pdk, library, corner in [
        ("sky130", "sky130A", "sky130_fd_sc_hd", "nom_tt_025C_1v80"),
        ("ihp_sg13g2", "ihp-sg13g2", "sg13g2_stdcell", "nom_typ_1p20V_25C"),
    ]:
        project = json.loads(original.read_text())
        project["technology"] = technology
        project["physical"].update(pdk=pdk, library=library)
        project["simulations"]["timing"]["timing_corner"] = corner
        project["source_roots"] = {"example": os.path.relpath(original.parent.resolve(), store.resolve())}
        for source in project["sources"]:
            source["path"] = dict(root="example", path=source["path"])
        for field in ["headers", "simulation_sources", "simulation_headers", "include_dirs", "assets"]:
            project[field] = [dict(root="example", path=f) for f in project.get(field, [])]
        for simulation in project["simulations"].values():
            for field in ["testbench", "models"]:
                simulation[field] = [dict(root="example", path=f) for f in simulation.get(field, [])]
            if simulation.get("sdf"):
                simulation["sdf"] = dict(root="example", path=simulation["sdf"])
        if project["physical"].get("sdc"):
            project["physical"]["sdc"] = dict(root="example", path=project["physical"]["sdc"])
        path = store / f"{technology}.project.json"
        path.write_text(json.dumps(project, indent=2))
        projects.append((technology, path, ["mapped"] + (["post_layout"] if args.physical else [])))

for name, project_path, stages in projects:
    for stage in stages:
        snapshot = run(["build", str(project_path), "--representation", stage], f"{name}/{stage}")
        if not snapshot:
            continue
        if args.schematics:
            view = run(["view", snapshot["directory"] + "/snapshot.json"], f"{name}/{stage}/view")
            assert view, f"{name}/{stage}: graph view failed"
            ports = {p["id"] for n in view["nodes"] for p in n["ports"]}
            assert all(p in ports for e in view["edges"] for p in e["sources"] + e["targets"]), "dangling display endpoint"
            if name == "schematic":
                kinds = {n["display"]["symbol"] for n in view["nodes"]}
                if stage == "source":
                    assert {"process", "function", "task", "assignment"} <= kinds
                    behavior = [c["behavior"] for c in snapshot["design"]["modules"]["showcase"]["cells"] if c.get("behavior")]
                    captured = {n["kind"] for b in behavior for n in b["nodes"]}
                    assert {"case", "loop", "event", "assignment", "function", "task", "return", "mux"} <= captured
                    assert any(e["label"] == "next" for b in behavior for e in b["edges"])
                    for b in behavior:
                        for n in b["nodes"]:
                            if n["kind"] == "assignment" and n["label"] == "count <=":
                                assert n["signals"] == ["count"], "assignment bound to a read instead of its target"
                    assert not any("Opaque source" in d["message"] for d in snapshot["diagnostics"]), snapshot["diagnostics"]
                elif stage == "elaborated":
                    assert {"register", "mux", "decoder", "encoder", "memory", "and", "xor", "operator"} <= kinds, kinds
                else:
                    assert "register" in kinds
            if stage == "mapped":
                assert any(n["display"]["symbol"] == "register" for n in view["nodes"]), f"{name}: no catalog register"
        configurations = ["rtl"]
        if name == "counter" and stage == "elaborated":
            configurations.append("verilator")
        if stage == "post_layout":
            configurations.append("timing")
        for configuration in configurations:
            simulation = run(["simulate", snapshot["directory"] + "/snapshot.json", "--configuration", configuration],
                             f"{name}/{stage}/{configuration}")
            if simulation:
                run(["wave", simulation["trace"]], f"{name}/{stage}/{configuration}/parse")
raise SystemExit(any(r["exit_code"] for r in records))
