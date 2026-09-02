import { mkdir,readFile,writeFile,mkdtemp,rm } from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import type { NodeSpec,ToolCall,ToolResult } from '@nexus/protocol';import { getTool } from '@nexus/tools';import { BrowserManager } from './browser.js';import { DesktopController } from './computer.js';import { commandExists,runProcess } from './process.js';
const text=(value:unknown,name:string)=>{if(typeof value!=='string'||!value)throw new Error(`${name} must be a non-empty string`);return value;};const optionalText=(value:unknown)=>typeof value==='string'&&value?value:undefined;const number=(value:unknown,fallback:number)=>typeof value==='number'&&Number.isFinite(value)?value:fallback;const bool=(value:unknown)=>value===true;
export class LocalToolRuntime{
  readonly browser=new BrowserManager();readonly desktop=new DesktopController();constructor(private readonly node:NodeSpec){}
  private ensure(call:ToolCall){const descriptor=getTool(call.name);if(!descriptor||descriptor.scope!=='node')throw new Error(`unknown node tool: ${call.name}`);for(const cap of descriptor.requiredCapabilities)if(!this.node.capabilities.includes(cap))throw new Error(`node ${this.node.id} lacks ${cap} for ${call.name}`);return descriptor;}
  async execute(call:ToolCall):Promise<ToolResult>{try{this.ensure(call);const a=call.arguments;let data:unknown;let images:ToolResult['images']=[];
    switch(call.name){
      case 'shell.exec':data=await runProcess((a.argv as unknown[]??[]).map(String),{cwd:optionalText(a.cwd),timeoutMs:number(a.timeoutMs,600_000)});break;
      case 'fs.read':{const file=text(a.path,'path');data={path:file,content:(await readFile(file,'utf8')).slice(0,500_000)};break;}
      case 'fs.write':{const file=text(a.path,'path');await mkdir(path.dirname(file),{recursive:true});await writeFile(file,text(a.content,'content'),'utf8');data={path:file,bytes:Buffer.byteLength(String(a.content))};break;}
      case 'git.status':data=await runProcess(['git','status','--porcelain=v1','-b'],{cwd:optionalText(a.cwd)});break;
      case 'git.diff':data=await runProcess(['git','diff',...(bool(a.staged)?['--cached']:[])],{cwd:optionalText(a.cwd)});break;
      case 'code.run':data=await this.runCode(text(a.language,'language'),text(a.code,'code'),optionalText(a.cwd),number(a.timeoutMs,120_000));break;
      case 'document.read':data=await this.readDocument(text(a.path,'path'),number(a.maxBytes,2_000_000));break;
      case 'browser.open':data=await this.browser.open({sessionId:optionalText(a.sessionId),url:optionalText(a.url),headless:a.headless===undefined?undefined:bool(a.headless)});break;
      case 'browser.navigate':data=await this.browser.navigate(text(a.sessionId,'sessionId'),text(a.url,'url'));break;
      case 'browser.click':data=await this.browser.click({sessionId:text(a.sessionId,'sessionId'),selector:optionalText(a.selector),x:typeof a.x==='number'?a.x:undefined,y:typeof a.y==='number'?a.y:undefined});break;
      case 'browser.type':data=await this.browser.type({sessionId:text(a.sessionId,'sessionId'),selector:optionalText(a.selector),text:text(a.text,'text')});break;
      case 'browser.extract':data=await this.browser.extract({sessionId:text(a.sessionId,'sessionId'),selector:optionalText(a.selector),mode:a.mode==='html'?'html':'text'});break;
      case 'browser.screenshot':{const shot=await this.browser.screenshot({sessionId:text(a.sessionId,'sessionId'),fullPage:bool(a.fullPage)});images=[{mimeType:shot.mimeType,dataBase64:shot.dataBase64}];data={sessionId:shot.sessionId,url:shot.url,title:shot.title};break;}
      case 'browser.close':data=await this.browser.close(text(a.sessionId,'sessionId'));break;
      case 'computer.screenshot':{const shot=await this.desktop.screenshot();images=[shot];data={captured:true};break;}
      case 'computer.click':data=await this.desktop.click(number(a.x,0),number(a.y,0),a.button==='right'?'right':'left');break;
      case 'computer.type':data=await this.desktop.type(text(a.text,'text'));break;
      case 'computer.key':data=await this.desktop.key(text(a.key,'key'));break;
      case 'computer.scroll':data=await this.desktop.scroll(number(a.deltaY,0));break;
      case 'computer.open_app':data=await this.desktop.openApp(text(a.name,'name'));break;
      default:throw new Error(`unimplemented node tool: ${call.name}`);
    }
    const rendered=typeof data==='string'?data:JSON.stringify(data);return{toolCallId:call.id,name:call.name,ok:true,text:rendered.slice(-120_000),data,images};
  }catch(error){return{toolCallId:call.id,name:call.name,ok:false,text:error instanceof Error?error.message:String(error),images:[]};}}
  private async runCode(language:string,code:string,cwd?:string,timeoutMs=120_000){const direct:Record<string,string[]>={python:['python3','-c',code],node:['node','-e',code],bash:['bash','-lc',code],ruby:['ruby','-e',code]};if(direct[language])return runProcess(direct[language]!,{cwd,timeoutMs});if(!['go','rust'].includes(language))throw new Error(`unsupported language: ${language}`);const dir=await mkdtemp(path.join(os.tmpdir(),'nexus-code-'));try{if(language==='go'){const file=path.join(dir,'main.go');await writeFile(file,code);return runProcess(['go','run',file],{cwd:cwd??dir,timeoutMs});}const file=path.join(dir,'main.rs'),bin=path.join(dir,'main');await writeFile(file,code);const compile=await runProcess(['rustc',file,'-O','-o',bin],{cwd:dir,timeoutMs});if(compile.exitCode!==0)return compile;return runProcess([bin],{cwd:cwd??dir,timeoutMs});}finally{await rm(dir,{recursive:true,force:true});}}
  private async readDocument(file:string,maxBytes:number){const ext=path.extname(file).toLowerCase();if(ext==='.pdf'&&await commandExists('pdftotext'))return runProcess(['pdftotext',file,'-'],{timeoutMs:60_000});if(['.docx','.odt','.rtf'].includes(ext)&&await commandExists('pandoc'))return runProcess(['pandoc','-t','plain',file],{timeoutMs:60_000});const buffer=(await readFile(file)).subarray(0,Math.max(1,Math.min(maxBytes,5_000_000)));if(buffer.includes(0))throw new Error(`binary document ${ext||'unknown'} needs pdftotext/pandoc or a future native parser`);return{path:file,content:buffer.toString('utf8')};}
}
