#!/usr/bin/env python3
"""Test the built package without installing it on the host."""
import hashlib
import json
import pathlib
import subprocess
import time

root = pathlib.Path.cwd()
trace = root / '.hdlview/package-smoke.vcd'
trace.parent.mkdir(parents=True, exist_ok=True)
trace.write_text('$timescale 1 ns $end\n$scope module tb $end\n$var wire 1 ! clock $end\n$upscope $end\n$enddefinitions $end\n#0\n0!\n#10\n1!\n')
base = ['docker', 'run', '--rm', '--network', 'none', '--mount',
        f'type=bind,src={root},dst=/work,readonly',
        '--env', 'WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1',
        'hdlview-desktop-builder:1.90']
# The WebKit override applies only to this disposable root-owned test container.
# It is not configured in the shipped desktop application.
checks = {}
result = subprocess.run(base + ['/work/target/linux-package/usr/bin/hdlview', 'wave', '/work/.hdlview/package-smoke.vcd'], capture_output=True, text=True, timeout=30)
assert result.returncode == 0, result.stderr
checks['packaged_cli_variables'] = len(json.loads(result.stdout)['variables'])
result = subprocess.run(base + ['ldd', '/work/target/linux-package/usr/bin/hdlview-desktop'], capture_output=True, text=True, timeout=30)
assert result.returncode == 0 and 'not found' not in result.stdout, result.stdout
checks['runtime_dependencies'] = 'resolved'
command = '''Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/tmp/hdlview-xvfb.log 2>&1 & display_pid=$!
sleep 1
DISPLAY=:99 timeout -k 2 10 /work/target/linux-package/usr/bin/hdlview-desktop
app_status=$?
kill "$display_pid"
cat /tmp/hdlview-xvfb.log
exit "$app_status"
'''
start = time.monotonic()
result = subprocess.run(base + ['bash', '-c', command], capture_output=True, text=True, timeout=30)
assert result.returncode == 124, (result.returncode, result.stderr)
checks['desktop_virtual_display_seconds'] = round(time.monotonic() - start, 2)
checks['desktop_stderr'] = result.stderr
package = root / 'target/packages/hdlview_0.1.0_amd64.deb'
checks['package_sha256'] = hashlib.sha256(package.read_bytes()).hexdigest()
(root / '.hdlview/package-smoke-results.json').write_text(json.dumps(checks, indent=2))
print(json.dumps(checks, indent=2))
