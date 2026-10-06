#!/usr/bin/env python3
"""Reproduce workflow qualification; physical failed_checks remain distinct."""
import argparse,json,pathlib,subprocess,time
parser=argparse.ArgumentParser();parser.add_argument('--profile',required=True);parser.add_argument('--physical',action='store_true');args=parser.parse_args()
store=pathlib.Path('.hdlview/qualification');store.mkdir(parents=True,exist_ok=True)
records=[]
def run(arguments,label):
 start=time.monotonic();result=subprocess.run(['target/debug/hdlview','--store',str(store),'--profile',args.profile,*arguments],capture_output=True,text=True)
 record={'case':label,'seconds':time.monotonic()-start,'exit_code':result.returncode,'error':result.stderr}
 value=json.loads(result.stdout) if result.returncode==0 else None
 if value and 'directory' in value:record['directory']=value['directory']
 if value and value.get('physical_run'):record['physical_status']=value['physical_run']['status']
 records.append(record);(store/'results.json').write_text(json.dumps(records,indent=2));print(label,result.returncode,record.get('physical_status',''),flush=True)
 return value
for language in ['counter','vhdl']:
 stages=['source','elaborated','generic']+(['mapped','post_layout'] if args.physical else [])
 for stage in stages:
  snapshot=run(['build',f'examples/{language}/hdlview.project.json','--representation',stage],f'{language}/{stage}')
  if not snapshot:continue
  configurations=['gates'] if language=='vhdl' and stage in ('generic','mapped','post_layout') else ['rtl']
  if language=='counter' and stage=='elaborated':configurations+=['verilator']
  if stage=='post_layout':configurations+=['timing']
  for name in configurations:
   simulation=run(['simulate',snapshot['directory']+'/snapshot.json','--configuration',name],f'{language}/{stage}/{name}')
   if simulation:run(['wave',simulation['trace']],f'{language}/{stage}/{name}/parse')
raise SystemExit(any(r['exit_code'] for r in records))
