#!/usr/bin/env python3
"""Measure 200 loaded signals over the same worker IPC used by the desktop."""
import json
import pathlib
import statistics
import subprocess
import time

folder = pathlib.Path('.hdlview/benchmarks')
folder.mkdir(parents=True, exist_ok=True)
trace = folder / 'many-signals.vcd'
with trace.open('w') as stream:
    stream.write('$timescale 1 ps $end\n$scope module tb $end\n')
    for i in range(200):
        stream.write(f'$var wire 32 s{i} bus{i} [31:0] $end\n')
    stream.write('$upscope $end\n$enddefinitions $end\n')
    for t in range(1000):
        stream.write(f'#{t}\n')
        for i in range(200):
            stream.write(f'b{(t+i)%4294967296:032b} s{i}\n')
worker = subprocess.Popen(['target/debug/hdlview', '--wave-worker'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
def request(value):
    worker.stdin.write(json.dumps(value)+'\n')
    worker.stdin.flush()
    reply = json.loads(worker.stdout.readline())
    if not reply['ok']:
        raise RuntimeError(reply['error'])
    return reply['result']
try:
    request({'open': str(trace)})
    durations = []
    for t in range(51):
        start = time.perf_counter()
        rows = request({'ids':list(range(200)), 'start':t*10, 'end':t*10, 'pixels':1})
        assert len(rows) == 200 and all(row['transitions'] for row in rows)
        if t:
            durations.append((time.perf_counter()-start)*1000)
    result = {'signals':200, 'queries':50, 'median_ms':statistics.median(durations), 'p95_ms':sorted(durations)[47], 'max_ms':max(durations)}
    (folder/'values-result.json').write_text(json.dumps(result,indent=2))
    print(json.dumps(result))
finally:
    worker.stdin.close()
    worker.wait(timeout=10)
