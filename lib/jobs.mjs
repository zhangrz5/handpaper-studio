import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { buildPrompt, GENERATION_INSTRUCTIONS, complexityFor } from './prompts.mjs';
import { imageBytes, imageFormat, generationSettings } from './codex.mjs';

const terminal = new Set(['completed','failed','cancelled']);
export class JobStore {
  constructor({ directory, client, timeoutMs=15*60*1000 }) {this.directory=directory;this.client=client;this.timeoutMs=timeoutMs;this.jobs=new Map();this.active=null;}
  async init() {
    await fs.mkdir(this.directory,{recursive:true});
    for(const name of await fs.readdir(this.directory)) {
      if(!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      try {
        const job=JSON.parse(await fs.readFile(path.join(this.directory,name),'utf8'));
        if(!terminal.has(job.status)) {job.status='failed';job.message='服务重启，任务已中断，请重新生成。';}
        this.jobs.set(job.id,job);
      } catch {}
    }
    this.client.on('disconnected',()=>{if(this.active)this.active.fail('本机 Codex 连接已断开，请重新生成。');});
    this.client.on('notification',message=>this.onNotification(message));
  }
  public(job) {const {threadId,turnId,prompt,...result}=job;return result;}
  list() {return [...this.jobs.values()].sort((a,b)=>b.createdAt-a.createdAt).map(j=>this.public(j));}
  async save(job) {
    const target=path.join(this.directory,job.id+'.json');
    const temporary=target+'.tmp';
    await fs.writeFile(temporary,JSON.stringify(job,null,2));await fs.rename(temporary,target);
  }
  async create(input) {
    if(this.active) throw Object.assign(new Error('正在生成一张手抄报，请完成后再开始。'),{status:409});
    const job={id:randomUUID(),input,complexity:complexityFor(input.grade),status:'queued',message:'正在准备画稿',createdAt:Date.now(),imageUrl:null};
    const context={job,threadId:null,images:[],pendingImages:[],timer:null,settled:false,fail:message=>this.finish(context,'failed',message)};
    this.active=context;this.jobs.set(job.id,job);await this.save(job);
    this.run(context).catch(error=>context.fail(error.message));
    return this.public(job);
  }
  async run(ctx) {
    const workspace=path.join(this.directory,ctx.job.id);
    await fs.mkdir(workspace,{recursive:true});
    await this.client.start(); if(ctx.settled)return;
    const {model,effort}=generationSettings();
    const params={model,config:{model_reasoning_effort:effort},cwd:workspace,approvalPolicy:'never',sandbox:'read-only',ephemeral:true,developerInstructions:GENERATION_INSTRUCTIONS};
    const thread=await this.client.request('thread/start',params);
    ctx.threadId=thread.thread.id;ctx.job.threadId=ctx.threadId;
    if(ctx.settled){await this.client.request('thread/archive',{threadId:ctx.threadId}).catch(()=>{});return;}
    ctx.job.model=thread.model || model;ctx.job.reasoningEffort=thread.reasoningEffort || effort;
    ctx.job.status='generating';ctx.job.message='正在构图与绘制，通常需要1–3分钟';await this.save(ctx.job);
    ctx.timer=setTimeout(()=>{this.cancel(ctx.job.id).catch(()=>{});},this.timeoutMs);
    const result=await this.client.request('turn/start',{threadId:ctx.threadId,model,effort,input:[{type:'text',text:buildPrompt(ctx.job.input)}]},60000);
    ctx.job.turnId=result.turn.id;
    if(ctx.settled)await this.client.request('turn/interrupt',{threadId:ctx.threadId,turnId:result.turn.id}).catch(()=>{});
  }
  onNotification({method,params}) {
    const ctx=this.active;if(!ctx || ctx.settled || params?.threadId!==ctx.threadId)return;
    if(method==='item/started' && params.item?.type==='imageGeneration') {ctx.job.message='正在绘制手抄报，请保留页面或稍后回来';ctx.job.status='generating';}
    if(method==='item/completed' && params.item?.type==='imageGeneration') {
      const task=this.captureImage(ctx,params.item).catch(()=>{});ctx.pendingImages.push(task);
    }
    if(method==='turn/started')ctx.job.turnId=params.turn.id;
    if(method==='turn/completed') {
      const result=params.turn;
      Promise.all(ctx.pendingImages).then(()=>{
        if(ctx.settled)return;
        if(result.status==='interrupted')return this.finish(ctx,'cancelled','本次生成已取消。');
        if(ctx.images.length && result.status==='completed') {
          ctx.job.imageUrl=ctx.images[0];return this.finish(ctx,'completed','画稿已完成，可以生成浅灰描绘版。');
        }
        const error=result.error?.message;
        return ctx.fail(error ? `生成未完成：${error.slice(0,200)}` : 'Codex 未返回图片。请确认当前订阅支持内置图片生成后重试。');
      }).catch(()=>ctx.fail('画稿保存失败，请重试。'));
    }
  }
  async captureImage(ctx,item) {
    let bytes=imageBytes(item);
    if(!bytes && item.savedPath) {
      const saved=path.resolve(item.savedPath);
      const roots=[path.resolve(process.env.CODEX_HOME || path.join(os.homedir(),'.codex'),'generated_images'),path.join(this.directory,ctx.job.id)];
      if(!roots.some(root=>{const relative=path.relative(root,saved);return relative!==''&&!relative.startsWith('..')&&!path.isAbsolute(relative);} ))return;
      const stat=await fs.stat(saved);if(stat.size>50*1024*1024)return;
      bytes=await fs.readFile(saved);
    }
    if(!bytes)return;
    const format=imageFormat(bytes);if(!format)return;
    const name=`${ctx.job.id}.${format}`;
    await fs.writeFile(path.join(this.directory,name),bytes);
    ctx.images.push('/api/images/'+name);
  }
  async finish(ctx,status,message) {
    if(ctx.settled)return;ctx.settled=true;clearTimeout(ctx.timer);
    ctx.job.status=status;ctx.job.message=message;ctx.job.completedAt=Date.now();
    await this.save(ctx.job).catch(()=>{});
    if(this.active===ctx)this.active=null;
    if(ctx.threadId)await this.client.request('thread/archive',{threadId:ctx.threadId}).catch(()=>{});
  }
  async cancel(id) {
    const ctx=this.active;if(!ctx||ctx.job.id!==id)return;
    if(ctx.threadId && ctx.job.turnId)await this.client.request('turn/interrupt',{threadId:ctx.threadId,turnId:ctx.job.turnId}).catch(()=>{});
    await this.finish(ctx,'cancelled','本次生成已取消。');
  }
}
