#!/usr/bin/env python3
"""Collect installed dependency notices for the application bundle."""
import json
import pathlib
import subprocess

out = [
    "# Third-party dependency notices\n",
    "Generated from installed locked dependencies. System libraries and external HDL "
    "toolchains retain their separate notices.\n",
    "\nHDLView itself is licensed under the GNU General Public License version 3 only "
    "(`LICENSE`), with this additional permission under GPL section 7: if you modify "
    "this Program, or any covered work, by linking or combining it with elkjs (or a "
    "modified version of that library), containing parts covered by the terms of the "
    "Eclipse Public License 2.0, the licensors of this Program grant you additional "
    "permission to convey the resulting work.\n",
]


def notices(directory):
    for file in sorted(directory.iterdir()):
        if file.is_file() and file.name.lower().startswith(("license", "copying", "notice")):
            out.extend([
                f"\n### {file.name}\n\n```text\n",
                file.read_text(errors="replace"),
                "\n```\n",
            ])


metadata = json.loads(subprocess.check_output([
    "cargo", "metadata", "--locked", "--format-version", "1",
]))
for package in sorted(metadata["packages"], key=lambda p: (p["name"], p["version"])):
    if not package.get("source"):
        continue
    out.extend([
        f"\n## {package['name']} {package['version']}\n",
        f"License: {package.get('license') or 'See source license'}\n",
        f"Source: {package.get('repository') or package['source']}\n",
    ])
    notices(pathlib.Path(package["manifest_path"]).parent)

lock = json.loads(pathlib.Path("package-lock.json").read_text())
for location, resolved in sorted(lock["packages"].items()):
    if not location or resolved.get("dev"):
        continue
    directory = pathlib.Path(location)
    package = json.loads((directory / "package.json").read_text())
    out.extend([
        f"\n## {package['name']} {package['version']}\n",
        f"License: {package.get('license') or 'See source license'}\n",
        f"Source: {resolved.get('resolved', '')}\n",
    ])
    notices(directory)

pathlib.Path("docs/THIRD_PARTY_NOTICES.md").write_text("".join(out))
