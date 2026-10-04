import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';

export function generationSettings() {
  return { model:process.env.CODEX_MODEL || 'gpt-6.1-sol', effort:process.env.CODEX_REASONING_EFFORT || 'high' };
}

export function findCodex() {
  const configured = process.env.CODEX_BIN;
  if (configured) {
    if (!existsSync(configured)) throw new Error('CODEX_BIN 指定的文件不存在。');
    return configured.endsWith('.js') ? { command:process.execPath, prefix:[configured] } : { command:configured, prefix:[] };
  }
  // The desktop app can ship newer model support than a globally installed CLI.
  if(process.platform==='win32') {
    const desktopBin=path.join(process.env.LOCALAPPDATA || path.join(os.homedir(),'AppData','Local'),'OpenAI','Codex','bin');
    try {
      const candidates=readdirSync(desktopBin,{withFileTypes:true}).filter(entry=>entry.isDirectory())
        .map(entry=>path.join(desktopBin,entry.name,'codex.exe')).filter(filename=>existsSync(filename))
        .sort((a,b)=>statSync(b).mtimeMs-statSync(a).mtimeMs);
      if(candidates.length)return {command:candidates[0],prefix:[]};
    } catch {}
  }
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const packages = [path.join(dir,'node_modules','@openai','codex'), path.resolve(dir,'..','lib','node_modules','@openai','codex')];
    for (const root of packages) {
      const platform = process.platform === 'win32' ? `win32-${process.arch}` : `${process.platform}-${process.arch}`;
      const target = process.platform === 'win32' ? `${process.arch==='arm64'?'aarch64':'x86_64'}-pc-windows-msvc` : process.platform === 'darwin' ? `${process.arch==='arm64'?'aarch64':'x86_64'}-apple-darwin` : `${process.arch==='arm64'?'aarch64':'x86_64'}-unknown-linux-musl`;
      const binary = process.platform === 'win32' ? 'codex.exe' : 'codex';
      const native = path.join(root,'node_modules','@openai',`codex-${platform}`,'vendor',target,'bin',binary);
      if (existsSync(native)) return {command:native,prefix:[]};
      const entry = path.join(root,'bin','codex.js');
      if (existsSync(entry)) return {command:process.execPath,prefix:[entry]};
    }
    const exe = path.join(dir,process.platform === 'win32'?'codex.exe':'codex');
    if (existsSync(exe)) return {command:exe,prefix:[]};
  }
  throw new Error('未找到 Codex，请安装 Codex CLI，或在 .env 设置 CODEX_BIN。');
}

export class CodexClient extends EventEmitter {
  constructor({ cwd, spawnProcess = spawn } = {}) {
    super(); this.cwd=cwd; this.spawnProcess=spawnProcess; this.nextId=1; this.pending=new Map(); this.ready=null; this.child=null;
  }
  async start() {
    if (this.ready) return this.ready;
    this.ready = this.connect().catch(error => { this.ready=null; throw error; });
    return this.ready;
  }
  async connect() {
    const executable = findCodex();
    const env={...process.env};
    // Subscription-only: never inherit an API billing credential into this worker.
    delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY;
    const args=[...executable.prefix,'app-server','--listen','stdio://','--enable','image_generation'];
    for (const feature of ['apps','plugins','multi_agent','browser_use','computer_use','shell_tool']) args.push('--disable',feature);
    args.push('-c','forced_login_method="chatgpt"','-c','model_provider="openai"','-c','web_search="disabled"');
    const child=this.spawnProcess(executable.command,args,{cwd:this.cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.child=child;
    const lines=createInterface({input:child.stdout});
    lines.on('line',line=>{try { this.receive(JSON.parse(line)); } catch {} });
    child.stderr.on('data',()=>{});
    const failed = () => {
      if (this.child !== child) return;
      this.child=null; this.ready=null;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('本机 Codex 连接已断开，请重试。')); }
      this.pending.clear(); this.emit('disconnected');
    };
    child.on('error',failed); child.on('exit',failed);
    await this.request('initialize',{clientInfo:{name:'handpaper_studio',title:'绘报工坊',version:'1.0.0'}});
    this.send({method:'initialized',params:{}});
    return this;
  }
  send(message) {
    if (!this.child || this.child.stdin.destroyed) throw new Error('Codex 尚未连接。');
    this.child.stdin.write(JSON.stringify(message)+'\n');
  }
  request(method,params={},timeout=30000) {
    return new Promise((resolve,reject)=>{
      const id=this.nextId++;
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Codex 连接超时，请检查登录和网络。'));},timeout);
      this.pending.set(id,{resolve,reject,timer});
      try { this.send({id,method,params}); } catch(error) {clearTimeout(timer);this.pending.delete(id);reject(error);}
    });
  }
  receive(message) {
    if (message.id !== undefined && !message.method) {
      const pending=this.pending.get(message.id); if(!pending) return;
      clearTimeout(pending.timer);this.pending.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message || 'Codex 请求失败。')) : pending.resolve(message.result);
    } else if (message.method && message.id !== undefined) {
      if (message.method.endsWith('/requestApproval')) this.send({id:message.id,result:{decision:'decline'}});
      else this.send({id:message.id,error:{code:-32601,message:'This image-only application does not permit interactive tools.'}});
    } else if (message.method) this.emit('notification',message);
  }
  async account() { await this.start();return this.request('account/read',{refreshToken:false}); }
  async login() {await this.start();return this.request('account/login/start',{type:'chatgptDeviceCode'},60000);}
  stop() {
    const child=this.child; if(!child) return;
    child.stdin.end(); const timer=setTimeout(()=>child.kill(),1000);timer.unref();
  }
}

export function imageBytes(item) {
  if (item.type !== 'imageGeneration' || ['failed','in_progress'].includes(item.status)) return null;
  const raw=item.result || '';
  const data=raw.startsWith('data:image/') ? raw.slice(raw.indexOf(',')+1) : raw;
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(data) || data.length<80 || data.length>70000000) return null;
  const bytes=Buffer.from(data,'base64');
  return imageFormat(bytes) ? bytes : null;
}
export function imageFormat(bytes) {
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255) return 'jpg';
  if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP') return 'webp';
  return null;
}
