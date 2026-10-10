"""Collect a LibreLane run's signoff results as one JSON file.

python3 collect_checks.py RUN_DIRECTORY STATE.json OUT.json

DRC and XOR markers come from the KLayout report databases the flow writes, LVS
from Netgen's JSON result, and the counts from the flow's metrics. A check with
neither a result file nor a metric is "not_run", never "clean".
Boxes are [x0, y0, x1, y1] in microns.
"""

import json
import pathlib
import re
import sys
import xml.etree.ElementTree as ElementTree

MARKERS_PER_RULE = 1000
NUMBER = r"-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?"
POINT = re.compile(f"({NUMBER}),({NUMBER})")


def newest(run, pattern):
    """The file of the last step that wrote one: a repeated step gets a suffix."""
    found = sorted(
        run.glob(pattern), key=lambda path: int(path.parts[len(run.parts)].split("-")[0])
    )
    return found[-1] if found else None


def markers(path):
    """Violations of a KLayout report database, grouped by rule."""
    root = ElementTree.parse(path).getroot()
    descriptions = {
        category.findtext("name", ""): category.findtext("description", "")
        for category in root.iter("category")
    }
    rules = {}
    count = 0
    for item in root.iter("item"):
        name = item.findtext("category", "").strip().strip("'")
        points = [
            (float(x), float(y))
            for value in item.iter("value")
            for x, y in POINT.findall(value.text or "")
        ]
        count += 1
        rule = rules.setdefault(
            name,
            {"rule": name, "description": descriptions.get(name, ""), "count": 0, "boxes": []},
        )
        rule["count"] += 1
        if points and len(rule["boxes"]) < MARKERS_PER_RULE:
            xs, ys = zip(*points)
            rule["boxes"].append([min(xs), min(ys), max(xs), max(ys)])
    return count, list(rules.values())


def names(side):
    return [entry[0] if isinstance(entry, list) else entry for entry in side]


def lvs(path, top):
    """Netgen's comparison: circuit 1 is the layout, circuit 2 the netlist."""
    cells = json.loads(path.read_text())
    mismatches = []
    summary = None
    for cell in cells:
        name = cell.get("name", ["", ""])
        for kind, key in (("net", "badnets"), ("device", "badelements")):
            for group in cell.get(key, []):
                if len(group) == 2:
                    mismatches.append(
                        {
                            "kind": kind,
                            "cell": name[0],
                            "layout": names(group[0]),
                            "netlist": names(group[1]),
                        }
                    )
        if name[0] == top and "devices" in cell and "nets" in cell:
            summary = {
                "devices": [sum(count for _, count in side) for side in cell["devices"]],
                "nets": cell["nets"],
            }
            pins = cell.get("pins", [[], []])
            if len(pins) == 2:
                layout = {pin.lower() for pin in pins[0]}
                netlist = {pin.lower() for pin in pins[1]}
                if layout != netlist:
                    mismatches.append(
                        {
                            "kind": "pin",
                            "cell": name[0],
                            "layout": sorted(layout - netlist),
                            "netlist": sorted(netlist - layout),
                        }
                    )
    return summary, mismatches


def main(run, state, target):
    run = pathlib.Path(run)
    metrics = json.loads(pathlib.Path(state).read_text()).get("metrics", {})
    top = json.loads((run / "resolved.json").read_text())["DESIGN_NAME"]

    def metric(*keys):
        values = [metrics[key] for key in keys if isinstance(metrics.get(key), (int, float))]
        return int(sum(values)) if values else None

    checks = []
    for identity, title, pattern, keys in (
        ("routing_drc", "Routing DRC", "*-openroad-detailedrouting/*.drc.xml", ["route__drc_errors"]),
        ("magic_drc", "Magic DRC", "*-magic-drc/reports/drc.magic.lyrdb", ["magic__drc_error__count"]),
        ("klayout_drc", "KLayout DRC", "*-klayout-drc/reports/drc.klayout.lyrdb", ["klayout__drc_error__count"]),
        ("xor", "XOR", "*-klayout-xor/xor.xml", ["design__xor_difference__count"]),
    ):
        path = newest(run, pattern)
        count = metric(*keys)
        check = {"id": identity, "title": title, "count": count, "rules": []}
        if path is not None:
            found, check["rules"] = markers(path)
            if count is None:
                check["count"] = found
        checks.append(check)

    check = {"id": "lvs", "title": "LVS", "count": metric("design__lvs_error__count")}
    path = newest(run, "*-netgen-lvs/reports/lvs.netgen.json")
    if path is not None:
        check["summary"], check["mismatches"] = lvs(path, top)
        if check["count"] is None:
            check["count"] = len(check["mismatches"])
    checks.append(check)
    checks.append(
        {
            "id": "antenna",
            "title": "Antenna",
            "count": metric("antenna__violating__nets", "antenna__violating__pins"),
        }
    )
    for check in checks:
        count = check["count"]
        check["status"] = "not_run" if count is None else "violations" if count else "clean"
    pathlib.Path(target).write_text(json.dumps({"checks": checks}, separators=(",", ":")))


if __name__ == "__main__":
    main(*sys.argv[1:])
