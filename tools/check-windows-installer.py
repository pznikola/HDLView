#!/usr/bin/env python3
"""Install the Windows setup silently, check it holds only the program, uninstall it."""
import pathlib
import subprocess
import sys
import tempfile
import time

expected = {"HDLView.exe", "uninstall.exe", "LICENSE.txt", "THIRD_PARTY_NOTICES.md"}
setup = pathlib.Path(sys.argv[1]).resolve()
target = pathlib.Path(tempfile.mkdtemp()) / "HDLView"
# NSIS reads /D= unquoted and only as the last argument.
subprocess.run(f'"{setup}" /S /D={target}', check=True, timeout=300)
found = {str(p.relative_to(target)) for p in target.rglob("*") if p.is_file()}
problems = [f"unexpected: {p}" for p in sorted(found - expected)]
problems += [f"missing: {p}" for p in sorted(expected - found)]
if not problems:
    # The uninstaller copies itself elsewhere and returns before it finishes.
    subprocess.run([str(target / "uninstall.exe"), "/S"], check=True, timeout=300)
    for _ in range(120):
        if not target.exists():
            break
        time.sleep(0.5)
    else:
        left = sorted(str(p.relative_to(target)) for p in target.rglob("*"))
        problems.append(f"left after uninstall: {left}")
print("\n".join(problems) or f"installer holds only {sorted(expected)}")
sys.exit(1 if problems else 0)
