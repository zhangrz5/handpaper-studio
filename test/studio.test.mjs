import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { complexityFor, STYLES, validateInput, buildPrompt } from '../lib/prompts.mjs';
import { tracePixels } from '../dist/tracing.mjs';
import { imageBytes } from '../lib/codex.mjs';
import { JobStore } from '../lib/jobs.mjs';
import { createStudio } from '../server.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const input={topic:'十一国庆',grade:8,style:'cool',orientation:'landscape',notes:'保留天安门与山河'};
const image=await fs.readFile(path.join(root,'dist/assets/example.png'));
await fs.mkdir(path.join(root,'test-output'),{recursive:true});
const temp=()=>fs.mkdtemp(path.join(root,'test-output','test-'));

class FakeClient extends EventEmitter {
  constructor(){super();this.subscription=true;this.calls=[];this.finish=false;}
  async start(){}
  async account(){return {account:{type:this.subscription?'chatgpt':'apiKey',planType:'pro'}};}
  async login(){return {type:'chatgptDeviceCode',verificationUrl:'https://auth.openai.com/codex/device',userCode:'TEST-1234'};}
  async request(method,params){
    this.calls.push({method,params});
    if(method==='thread/start')return {thread:{id:'test-thread'}};
    if(method==='model/list')return {data:[{model:'test-subscription-model',isDefault:true}]};
    if(method==='turn/start'){
      if(this.finish)setTimeout(()=>this.complete(),10);
      return {turn:{id:'test-turn'}};
    }
    return {};
  }
  complete(){
    this.emit('notification',{method:'item/completed',params:{threadId:'test-thread',item:{type:'imageGeneration',status:'completed',result:image.toString('base64')}}});
    this.emit('notification',{method:'turn/completed',params:{threadId:'test-thread',turn:{id:'test-turn',status:'completed'}}});
  }
  stop(){}
}
const eventually=async check=>{for(let i=0;i<100;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Timed out waiting for job');};

test('all 12 grades increase the detail budget and never reduce panel/element counts',()=>{
  let previous={detailBudget:0,panels:0,elements:0};
  for(let grade=1;grade<=12;grade++){
    const c=complexityFor(grade);assert.ok(c.detailBudget>previous.detailBudget);assert.ok(c.panels>=previous.panels);assert.ok(c.elements>=previous.elements);previous=c;
    assert.match(buildPrompt({...input,grade}),new RegExp('第'+grade+'/12级'));
  }
  for(const grade of [0,13,1.2,'invalid'])assert.throws(()=>complexityFor(grade));
});
test('all eight presets are real prompt instructions and invalid settings are rejected',()=>{
  assert.equal(Object.keys(STYLES).length,8);
  for(const style of Object.keys(STYLES)){const v=validateInput({...input,style});assert.ok(buildPrompt(v).includes(STYLES[style].description));}
  assert.throws(()=>validateInput({...input,style:'__proto__'}));assert.throws(()=>validateInput({...input,topic:''}));assert.throws(()=>validateInput({...input,notes:'x'.repeat(1201)}));
});
test('tracing produces pale gray contours, white interiors, and consistent geometry',()=>{
  const width=40,height=30, pixels=new Uint8ClampedArray(width*height*4);pixels.fill(255);
  for(let y=8;y<22;y++)for(let x=10;x<30;x++){const p=(y*width+x)*4;pixels[p]=pixels[p+1]=pixels[p+2]=0;}
  const light=tracePixels(pixels,width,height,20),dark=tracePixels(pixels,width,height,40);
  assert.equal(light[(15*width+20)*4],255);assert.equal(light[0],255);
  let edgeCount=0;for(let i=0;i<light.length;i+=4){assert.equal(light[i],light[i+1]);assert.equal(light[i],light[i+2]);assert.equal(light[i+3],255);assert.ok(light[i]>=204);if(light[i]<255){edgeCount++;assert.ok(dark[i]<=light[i]);}}
  assert.ok(edgeCount>0&&edgeCount<width*height/3);
  assert.deepEqual(tracePixels(new Uint8ClampedArray(pixels.length).fill(255),width,height),new Uint8ClampedArray(pixels.length).fill(255));
});
test('provider accepts actual image items and rejects arbitrary result strings',()=>{
  assert.deepEqual(imageBytes({type:'imageGeneration',status:'completed',result:image.toString('base64')}),image);
  assert.equal(imageBytes({type:'agentMessage',result:image.toString('base64')}),null);
  assert.equal(imageBytes({type:'imageGeneration',status:'completed',result:'file:///etc/passwd'}),null);
});

test('all tracing widths stay fine, increase gradually, and preserve small gaps',()=>{
  const width=80,height=70,pixels=new Uint8ClampedArray(width*height*4).fill(255);
  for(let y=20;y<50;y++)for(let x=20;x<60;x++){const p=(y*width+x)*4;pixels[p]=pixels[p+1]=pixels[p+2]=0;}
  const at=(image,x,y)=>image[(y*width+x)*4];
  const inkAmount=image=>image.reduce((sum,v,i)=>sum+(i%4===0?255-v:0),0);
  let previous=0;
  for(let lineWidth=1;lineWidth<=5;lineWidth++) {
    const light=tracePixels(pixels,width,height,20,lineWidth),dark=tracePixels(pixels,width,height,40,lineWidth);
    assert.ok(inkAmount(light)>previous);previous=inkAmount(light);
    assert.equal(at(light,40,35),255);assert.equal(at(light,1,1),255);
    assert.equal(at(light,19,35),at(light,60,35));
    assert.ok(Math.min(...light)>=204);
    assert.equal(at(light,19,35),204);assert.equal(at(dark,19,35),153);
    const stroke=Array.from({length:10},(_,x)=>at(light,15+x,35)).filter(v=>v<255);
    assert.equal(stroke.length,lineWidth===1?1:3);
    if(lineWidth===5)assert.ok(stroke[0]>stroke[1]&&stroke[2]>stroke[1]);
  }
  const empty=new Uint8ClampedArray(pixels.length).fill(255);
  assert.deepEqual(tracePixels(empty,width,height,50,5),empty);
  for(let y=20;y<50;y++)for(const start of [20,29])for(let x=start;x<start+4;x++){const p=(y*width+x)*4;empty[p]=empty[p+1]=empty[p+2]=0;}
  const thin=tracePixels(empty,width,height,24,1),widest=tracePixels(empty,width,height,24,5);
  assert.equal(at(thin,26,35),255);assert.equal(at(widest,26,35),255);
});
test('a streamed image is persisted and restores after a restart; active jobs are bounded',async()=>{
  const directory=await temp(),client=new FakeClient(),store=new JobStore({directory,client});await store.init();
  const job=await store.create(input);await assert.rejects(store.create(input),/正在生成/);
  await eventually(()=>client.calls.some(c=>c.method==='turn/start'));
  const started=client.calls.find(c=>c.method==='thread/start');assert.equal(started.params.sandbox,'read-only');assert.equal(started.params.approvalPolicy,'never');
  assert.equal(started.params.model,'gpt-6.1-sol');assert.equal(started.params.config.model_reasoning_effort,'high');
  const turn=client.calls.find(c=>c.method==='turn/start');assert.equal(turn.params.model,'gpt-6.1-sol');assert.equal(turn.params.effort,'high');
  client.complete();await eventually(()=>store.jobs.get(job.id).status==='completed');
  assert.ok(store.jobs.get(job.id).imageUrl.endsWith('.png'));
  await eventually(()=>store.active===null);
  const restarted=new JobStore({directory,client:new FakeClient()});await restarted.init();assert.equal(restarted.jobs.get(job.id).status,'completed');
  assert.equal(restarted.jobs.get(job.id).model,'gpt-6.1-sol');assert.equal(restarted.jobs.get(job.id).reasoningEffort,'high');
  const next=await store.create(input);await eventually(()=>store.jobs.get(next.id).turnId);await store.cancel(next.id);assert.equal(store.jobs.get(next.id).status,'cancelled');assert.equal(store.active,null);
});
test('no password is required; same-origin and CSRF checks remain; API billing cannot generate',async()=>{
  const client=new FakeClient();client.finish=true;
  const app=await createStudio({root,dataDirectory:await temp(),client});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+app.server.address().port;
  const call=(route,options={})=>fetch(origin+route,options);
  try{
    assert.equal((await call('/')).status,200);
    assert.equal((await call('/api/jobs')).status,200);
    const session=await call('/api/session').then(r=>r.json());assert.equal(session.authenticated,true);
    const headers={'content-type':'application/json','x-studio-csrf':session.csrf};
    assert.equal((await call('/api/jobs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)})).status,403);
    assert.equal((await call('/api/jobs',{method:'POST',headers:{...headers,origin:'https://other.example'},body:JSON.stringify(input)})).status,403);
    client.subscription=false;
    assert.equal((await call('/api/jobs',{method:'POST',headers,body:JSON.stringify(input)})).status,409);
    client.subscription=true;
    const response=await call('/api/jobs',{method:'POST',headers,body:JSON.stringify(input)});assert.equal(response.status,202);
    const job=await response.json();await eventually(()=>app.store.jobs.get(job.id).status==='completed');
    const imageUrl=app.store.jobs.get(job.id).imageUrl;
    assert.equal((await call(imageUrl)).status,200);
    assert.equal((await call('/api/images/../../server.mjs')).status,404);
  }finally{await new Promise(resolve=>app.server.close(resolve));}
});
