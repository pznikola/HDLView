"""Compare HDLView mask geometry with KLayout, including polygon coverage.

klayout -b -r tools/check-mask-geometry.py \
  -rd input_gds=design.gds -rd input_masks=layout_masks.json
"""

import collections
import json

import pya


def region(shapes):
    result = pya.Region()
    boxes = shapes.get("boxes", [])
    for at in range(0, len(boxes), 4):
        result.insert(pya.Box(*boxes[at:at + 4]))
    for polygon in shapes.get("polygons", []):
        result.insert(pya.Polygon([
            pya.Point(polygon[at], polygon[at + 1])
            for at in range(0, len(polygon), 2)
        ]))
    return result


with open(input_masks, encoding="utf-8") as stream:  # noqa: F821
    masks = json.load(stream)
layout = pya.Layout()
layout.read(input_gds)  # noqa: F821
top = layout.cell(masks["top"])
assert top is not None, "GDS top cell differs"
assert abs(layout.dbu - 1 / masks["dbu"]) < 1e-12, "Database units differ"

expected = collections.Counter()
for instance in top.each_inst():
    for transform in instance.cell_inst.each_trans():
        expected[(instance.cell.name, transform.disp.x, transform.disp.y,
                  transform.angle + 4 * transform.is_mirror())] += 1
actual = collections.Counter(
    (masks["cells"][cell]["name"], x, y, code)
    for cell, x, y, code in masks["instances"]
)
assert actual == expected, "Placements differ in cell, coordinates or orientation"

comparisons = 0
for index, layer in enumerate(masks["layers"]):
    number, datatype = map(int, layer["source"].split("/"))
    source = layout.find_layer(number, datatype)
    reference = pya.Region(top.shapes(source)) if source is not None else pya.Region()
    difference = reference ^ region(masks["shapes"][index])
    assert difference.is_empty(), f"Top coverage differs on {layer['source']}: {difference.area()} DBU²"
    comparisons += 1
    for cell in masks["cells"]:
        reference_cell = layout.cell(cell["name"])
        assert reference_cell is not None, f"Missing cell {cell['name']}"
        reference = pya.Region(reference_cell.begin_shapes_rec(source)) if source is not None else pya.Region()
        difference = reference ^ region(cell["layers"].get(str(index), {}))
        assert difference.is_empty(), f"{cell['name']} coverage differs on {layer['source']}: {difference.area()} DBU²"
        comparisons += 1
print(json.dumps({"top": masks["top"], "placements": sum(actual.values()),
                  "layer_cell_comparisons": comparisons, "coverage_xor_dbu2": 0}))
