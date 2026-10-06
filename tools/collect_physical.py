"""Keep LibreLane's non-finite metrics as explicit strings in strict JSON."""
import json
import pathlib
import sys
source, destination = map(pathlib.Path, sys.argv[1:])
state = json.loads(source.read_text(), parse_constant=lambda value: value)
destination.write_text(json.dumps(state, allow_nan=False, indent=2))
