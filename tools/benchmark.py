#!/usr/bin/env python3
"""Generate and measure a large VCD; outputs measured data, never target claims."""
import argparse,json,pathlib,subprocess,time,platform
p=argparse.ArgumentParser();p.add_argument('--mib',type=int,default=1024);args=p.parse_args()
directory=pathlib.Path('.hdlview/benchmarks');directory.mkdir(parents=True,exist_ok=True)
trace=directory/'large.vcd'
with trace.open('wb') as f:
 f.write(b'$timescale 1 ps $end\n$scope module tb $end\n$var wire 32 ! bus [31:0] $end\n$upscope $end\n$enddefinitions $end\n')
 stamp=0
 while f.tell()<args.mib*1024*1024:
  chunk=[]
  for _ in range(10000):
   chunk.append(f'#{stamp}\nb{stamp%4294967296:032b} !\n');stamp+=1
  f.write(''.join(chunk).encode())
start=time.monotonic()
result=subprocess.run(['/usr/bin/time','-v','target/debug/hdlview','wave',str(trace)],capture_output=True,text=True)
report={'platform':platform.platform(),'bytes':trace.stat().st_size,'wall_seconds':time.monotonic()-start,'exit_code':result.returncode,'resource_report':result.stderr,'metadata':json.loads(result.stdout) if result.returncode==0 else None}
(directory/'vcd-result.json').write_text(json.dumps(report,indent=2));print(json.dumps({k:v for k,v in report.items() if k!='metadata'},indent=2))
