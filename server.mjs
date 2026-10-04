import http from 'node:http';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import { CodexClient, generationSettings } from './lib/codex.mjs';
import { JobStore } from './lib/jobs.mjs';
import { validateInput, STYLES, GRADES } from './lib/prompts.mjs';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp'};
export function loadEnv(root=ROOT) {
  const file=path.join(root,'.env');if(!existsSync(file))return;
  for(const line of readFileSync(file,'utf8').split(/\r?\n/)) {
    const match=line.match(/^\s*([A-Z_][A-Z_0-9]*)\s*=\s*(.*?)\s*$/);
    if(match && !process.env[match[1]])process.env[match[1]]=match[2].replace(/^(["'])(.*)\1$/,'$2');
  }
}
const equal=(a,b)=>{const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&timingSafeEqual(x,y);};
const safeFile=(root,relative)=>{const target=path.resolve(root,relative);const rel=path.relative(root,target);return rel!==''&&!rel.startsWith('..')&&!path.isAbsolute(rel)?target:null;};
async function readBody(req,limit=16384) {
  if(!req.headers['content-type']?.startsWith('application/json'))throw Object.assign(new Error('请使用JSON提交。'),{status:415});
  let length=0;const chunks=[];
  for await(const chunk of req){length+=chunk.length;if(length>limit)throw Object.assign(new Error('提交内容太长。'),{status:413});chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Object.assign(new Error('提交内容格式有误。'),{status:400});}
}

export async function createStudio({root=ROOT,dataDirectory=path.join(ROOT,'data'),client:providedClient}={}) {
  await fs.mkdir(dataDirectory,{recursive:true});
  const client=providedClient || new CodexClient({cwd:root});
  const store=new JobStore({directory:path.join(dataDirectory,'jobs'),client});await store.init();
  const csrf=randomBytes(32).toString('base64url');let login=null;
  const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url=new URL(req.url,'http://studio.local');
      const origin=req.headers.origin;
      if(origin && (!/^https?:\/\//.test(origin) || new URL(origin).host!==req.headers.host))return json(res,403,{error:'请从本站页面操作。'});
      if(url.pathname==='/api/session' && req.method==='GET')return json(res,200,{authenticated:true,csrf});
      if(url.pathname.startsWith('/api/')) {
        if(req.method!=='GET' && !equal(req.headers['x-studio-csrf'],csrf))return json(res,403,{error:'页面已更新，请刷新重试。'});
        if(url.pathname==='/api/status'&&req.method==='GET') {
          try {
            const result=await client.account();const account=result.account;
            return json(res,200,{connected:true,subscription:account?.type==='chatgpt',plan:account?.type==='chatgpt'?account.planType:null,...generationSettings(),loginPending:!!login,activeJob:store.active?.job.id||null,grades:GRADES,styles:STYLES});
          } catch(error) {return json(res,200,{connected:false,subscription:false,error:error.message,activeJob:store.active?.job.id||null});}
        }
        if(url.pathname==='/api/login'&&req.method==='POST') {
          if(login)return json(res,200,login);
          const result=await client.login();
          login=result.type==='chatgptDeviceCode'?{type:result.type,url:result.verificationUrl,code:result.userCode}: {type:result.type,url:result.authUrl,code:null};
          setTimeout(()=>{login=null;},15*60*1000).unref();return json(res,200,login);
        }
        if(url.pathname==='/api/jobs'&&req.method==='GET')return json(res,200,{jobs:store.list()});
        if(url.pathname==='/api/jobs'&&req.method==='POST') {
          const input=validateInput(await readBody(req));
          const {account}=await client.account();
          if(account?.type!=='chatgpt')return json(res,409,{error:'请先连接本机的 ChatGPT / Codex 订阅，再开始生成。'});
          return json(res,202,await store.create(input));
        }
        const jobMatch=url.pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})(\/cancel)?$/);
        if(jobMatch) {
          const job=store.jobs.get(jobMatch[1]);if(!job)return json(res,404,{error:'没有找到这张画稿。'});
          if(jobMatch[2]&&req.method==='POST'){await store.cancel(job.id);return json(res,200,store.public(job));}
          if(!jobMatch[2]&&req.method==='GET')return json(res,200,store.public(job));
        }
        const image=url.pathname.match(/^\/api\/images\/([a-f0-9-]{36}\.(png|jpg|webp))$/);
        if(image&&req.method==='GET') {
          const buffer=await fs.readFile(path.join(store.directory,image[1]));
          res.writeHead(200,{'Content-Type':mime['.'+image[2]],'Cache-Control':'private, max-age=3600'});return res.end(buffer);
        }
        return json(res,404,{error:'请求地址不存在。'});
      }
      if(!['GET','HEAD'].includes(req.method))return json(res,405,{error:'不支持这个操作。'});
      const staticRoot=path.join(root,'dist');
      const requested=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname).replace(/^\//,'');
      const filename=safeFile(staticRoot,requested);if(!filename)return json(res,404,{error:'文件不存在。'});
      const buffer=await fs.readFile(filename);
      res.writeHead(200,{'Content-Type':mime[path.extname(filename)]||'application/octet-stream','Cache-Control':'no-cache'});
      return res.end(req.method==='HEAD'?undefined:buffer);
    } catch(error) {
      if(res.headersSent){res.end();return;}
      json(res,error.status||((error.code==='ENOENT')?404:400),{error:error.code==='ENOENT'?'文件不存在。':error.message||'操作失败，请重试。'});
    }
  });
  client.on('notification',message=>{if(message.method==='account/login/completed'||message.method==='account/updated')login=null;});
  server.requestTimeout=30000;server.headersTimeout=15000;
  server.on('close',()=>client.stop());
  return {server,client,store};
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  loadEnv();const app=await createStudio();
  const port=Number(process.env.PORT||8787),host=process.env.HOST||'127.0.0.1';
  app.server.listen(port,host,()=>{
    console.log(`\n绘报工坊已启动\n电脑访问：http://127.0.0.1:${port}\nfrp 映射本机端口：${port}\n直接访问，无需口令。`);
    if(host==='0.0.0.0')for(const group of Object.values(os.networkInterfaces()))for(const address of group||[])if(address.family==='IPv4'&&!address.internal)console.log(`同一 Wi-Fi 手机访问：http://${address.address}:${port}`);
  });
  app.server.on('error',error=>{console.error(error.code==='EACCES'?'该端口不可用，请在 .env 修改 PORT 后重试。':error.code==='EADDRINUSE'?'端口被占用，请关闭已有服务或在 .env 修改 PORT。':error.message);process.exitCode=1;app.client.stop();});
  const shutdown=()=>{app.client.stop();app.server.close();setTimeout(()=>process.exit(0),1500).unref();};
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}
