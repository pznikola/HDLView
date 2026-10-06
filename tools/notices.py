#!/usr/bin/env python3
"""Collect installed dependency notices for the application bundle."""
import json,pathlib,subprocess
out=['# Third-party dependency notices\n','Generated from installed locked dependencies. System libraries and external HDL toolchains retain their separate notices.\n']
metadata=json.loads(subprocess.check_output(['cargo','metadata','--locked','--format-version','1']))
for package in sorted(metadata['packages'],key=lambda p:p['name']):
 if not package.get('source'):continue
 out += [f"\n## {package['name']} {package['version']}\n",f"License: {package.get('license') or 'See source license'}\n",f"Source: {package.get('repository') or package['source']}\n"]
 directory=pathlib.Path(package['manifest_path']).parent
 for f in sorted(directory.iterdir()):
  if f.is_file() and f.name.lower().startswith(('license','copying','notice')):
   out += [f'\n### {f.name}\n\n```text\n',f.read_text(errors='replace'),'\n```\n']
for name in ['react','react-dom','@tauri-apps/api','elkjs']:
 directory=pathlib.Path('node_modules')/name;package=json.loads((directory/'package.json').read_text());out += [f"\n## {name} {package['version']}\n",f"License: {package.get('license')}\n"]
 for f in sorted(directory.iterdir()):
  if f.is_file() and f.name.lower().startswith(('license','copying','notice')):out += ['\n```text\n',f.read_text(errors='replace'),'\n```\n']
pathlib.Path('docs/THIRD_PARTY_NOTICES.md').write_text(''.join(out))
