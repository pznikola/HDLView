"""Write the placed and routed block of an OpenROAD database as JSON.

Run by OpenROAD's Python: openroad -exit -no_splash -python layout_dump.py IN.odb OUT.json
Boxes are [x0, y0, x1, y1] in database units; shapes end with the index of their net.
An instance ends with its orientation; a master's shapes are in its own coordinates.
"""

import json
import sys

import odb


def box(shape):
    return [shape.xMin(), shape.yMin(), shape.xMax(), shape.yMax()]


def decode(wire):
    """The boxes of a routed wire: its segments and the metal of its vias.

    Minimum-area patches are left out: the Python decoder cannot return them.
    """
    decoder = odb.dbWireDecoder()
    decoder.begin(wire)
    layer = None
    last = None
    while True:
        code = decoder.next()
        if code == odb.dbWireDecoder.END_DECODE:
            return
        if code in (
            odb.dbWireDecoder.PATH,
            odb.dbWireDecoder.JUNCTION,
            odb.dbWireDecoder.SHORT,
            odb.dbWireDecoder.VWIRE,
        ):
            layer = decoder.getLayer()
            last = None
        elif code in (odb.dbWireDecoder.POINT, odb.dbWireDecoder.POINT_EXT):
            point = decoder.getPoint()[:2]
            if last is not None and last != point:
                half = layer.getWidth() // 2
                yield layer, [
                    min(last[0], point[0]) - half,
                    min(last[1], point[1]) - half,
                    max(last[0], point[0]) + half,
                    max(last[1], point[1]) + half,
                ]
            last = point
        elif code in (odb.dbWireDecoder.VIA, odb.dbWireDecoder.TECH_VIA):
            via = (
                decoder.getVia()
                if code == odb.dbWireDecoder.VIA
                else decoder.getTechVia()
            )
            for part in via.getBoxes():
                metal = part.getTechLayer()
                if metal is not None and last is not None:
                    yield metal, [
                        part.xMin() + last[0],
                        part.yMin() + last[1],
                        part.xMax() + last[0],
                        part.yMax() + last[1],
                    ]
            layer = decoder.getLayer()


def abstract(master):
    """A cell as its library describes it, for naming and picking."""
    return {
        "class": master.getType(),
        "width": master.getWidth(),
        "height": master.getHeight(),
    }


def main(source, target):
    database = odb.dbDatabase.create()
    odb.read_db(database, source)
    block = database.getChip().getBlock()
    layers = [
        layer.getName()
        for layer in database.getTech().getLayers()
        if layer.getType() == "ROUTING"
    ]
    index = {name: number for number, name in enumerate(layers)}

    masters = {}
    instances = []
    for instance in block.getInsts():
        master = instance.getMaster()
        if master.getName() not in masters:
            masters[master.getName()] = (len(masters), abstract(master))
        number = masters[master.getName()][0]
        instances.append(
            [instance.getName(), number, *box(instance.getBBox()), instance.getOrient()]
        )

    pins = []
    for terminal in block.getBTerms():
        for pin in terminal.getBPins():
            for shape in pin.getBoxes():
                layer = shape.getTechLayer()
                if layer is not None and layer.getName() in index:
                    pins.append(
                        [
                            terminal.getName(),
                            index[layer.getName()],
                            *box(shape),
                            terminal.getIoType(),
                            terminal.getSigType(),
                        ]
                    )

    nets = []
    wires = [[] for _ in layers]
    power = [[] for _ in layers]
    for net in block.getNets():
        number = len(nets)
        nets.append(net.getName())
        wire = net.getWire()
        if wire is not None:
            for layer, shape in decode(wire):
                if layer.getName() in index:
                    wires[index[layer.getName()]].append([*shape, number])
        for special in net.getSWires():
            for shape in special.getWires():
                layer = None if shape.isVia() else shape.getTechLayer()
                if layer is not None and layer.getName() in index:
                    power[index[layer.getName()]].append([*box(shape), number])

    core = block.getCoreArea()
    result = {
        "dbu": block.getDbUnitsPerMicron(),
        "die": box(block.getDieArea()),
        "core": box(core),
        "layers": layers,
        "cuts": [
            layer.getName()
            for layer in database.getTech().getLayers()
            if layer.getType() == "CUT"
        ],
        "masters": [
            {"name": name, **view}
            for name, (_, view) in sorted(masters.items(), key=lambda item: item[1][0])
        ],
        "instances": instances,
        "pins": pins,
        "nets": nets,
        "wires": wires,
        "power": power,
    }
    with open(target, "w", encoding="utf8") as output:
        json.dump(result, output, separators=(",", ":"))


main(sys.argv[1], sys.argv[2])
