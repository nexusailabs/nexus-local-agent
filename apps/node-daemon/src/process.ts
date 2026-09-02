import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { ExecResult } from '@nexus/protocol';

const MAX_CAPTURE = 4 * 1024 * 1024;
export async function runProcess(argv:string[],options:{cwd?:string;env?:Record<string,string>;timeoutMs?:number;stdin?:string}={}):Promise<ExecResult>{
  if(!argv.length) throw new Error('argv is required'); const started=performance.now(); const timeoutMs=options.timeoutMs??600_000;
  return new Promise((resolve,reject)=>{const child=spawn(argv[0]!,argv.slice(1),{cwd:options.cwd,env:{...process.env,...options.env},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
    const append=(current:string,value:Buffer|string)=>{const next=current+value.toString();return next.length>MAX_CAPTURE?next.slice(-MAX_CAPTURE):next;};
    const timer=setTimeout(()=>child.kill('SIGKILL'),timeoutMs); child.stdout.on('data',(data)=>stdout=append(stdout,data));child.stderr.on('data',(data)=>stderr=append(stderr,data));child.on('error',reject);
    if(options.stdin){child.stdin.write(options.stdin);child.stdin.end();}else child.stdin.end();
    child.on('close',(exitCode,signal)=>{clearTimeout(timer);resolve({exitCode,signal:signal?String(signal):null,stdout,stderr,durationMs:Math.round(performance.now()-started)});});
  });
}
export async function commandExists(name:string):Promise<boolean>{const result=await runProcess(['sh','-lc',`command -v ${name.replace(/[^a-zA-Z0-9_.-]/g,'')}`],{timeoutMs:5_000});return result.exitCode===0&&Boolean(result.stdout.trim());}
