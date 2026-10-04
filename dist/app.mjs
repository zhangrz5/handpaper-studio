const $ = id => document.getElementById(id);
const grades=['小学一年级','小学二年级','小学三年级','小学四年级','小学五年级','小学六年级','初一','初二','初三','高一','高二','高三'];
const styleNames={guochao:'国潮大气',cool:'酷炫风',cartoon:'活泼卡通',nature:'清新自然',future:'科技未来',anime:'动漫热血',blackgold:'黑金大气',space:'梦幻星空'};
let csrf=null,subscription=false,currentJob=null,pollTimer=null,clockTimer=null,toastTimer=null,traceUrl=null,view='color',traceRevision=0;
let sourceUrl='/assets/example.png',artInput={topic:'十一国庆 · 盛世中华',grade:7,style:'guochao',orientation:'landscape'};
const worker = new Worker('/trace-worker.mjs',{type:'module'});
let pendingTrace=null;
const traceWidthNames=['极细','纤细','细线','适中','稍粗'];
worker.onmessage=({data})=>{if(pendingTrace){const request=pendingTrace;pendingTrace=null;data.error?request.reject(new Error(data.error)):request.resolve(data);}};
worker.onerror=()=>{if(pendingTrace){pendingTrace.reject(new Error('描绘版生成失败，请刷新重试。'));pendingTrace=null;}};

async function api(url,{method='GET',body}={}) {
  const response=await fetch(url,{method,headers:{'Content-Type':'application/json',...(csrf?{'X-Studio-Csrf':csrf}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const result=await response.json();
  if(!response.ok) {
    if(response.status===403){const session=await fetch('/api/session').then(r=>r.json());csrf=session.csrf;}
    throw new Error(result.error||'操作失败，请重试。');
  }
  return result;
}
function toast(message) {$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,4500);}
function storePreference(key,value) {try{localStorage.setItem(key,JSON.stringify(value));}catch{}}
function getPreference(key){try{return JSON.parse(localStorage.getItem(key));}catch{return null;}}
function updateComplexity() {
  const grade=Number($('grade').value);
  const band=grade<=2?['入门','大轮廓、少装饰，多留白，轻松画出来。']:grade<=4?['基础','清楚的色块与少量装饰，逐步增加配图。']:grade<=6?['进阶','增加配图与前后层次，细节保持容易临摹。']:grade<=9?['丰富','构图更丰富，保留清晰轮廓，避免细碎纹理。']:['精致','增加装饰纹样和细节，保持手绘可完成。'];
  $('complexity-title').textContent=`${band[0]} · ${grade}/12`;$('complexity-description').textContent=band[1];
  $('complexity-bars').replaceChildren(...Array.from({length:12},(_,i)=>{const e=document.createElement('span');if(i<grade)e.className='filled';return e;}));
}
function inputValue() {return {topic:$('topic').value.trim(),grade:Number($('grade').value),style:document.querySelector('input[name=style]:checked').value,orientation:$('orientation').value,notes:$('notes').value.trim()};}
function restoreInput(input) {if(!input)return;for(const key of ['topic','grade','orientation','notes'])if(input[key]!==undefined)$(key).value=input[key];const radio=document.querySelector(`input[name=style][value="${Object.hasOwn(styleNames,input.style)?input.style:'guochao'}"]`);if(radio)radio.checked=true;updateComplexity();countNotes();}
function countNotes(){$('notes-count').textContent=`${$('notes').value.length} / 1200`;}
function clearTrace() {if(traceUrl)URL.revokeObjectURL(traceUrl);traceUrl=null;traceRevision++;}
function setView(next) {
  if(next==='trace'&&!traceUrl)return;
  view=next;
  $('preview-image').src=next==='trace'?traceUrl:sourceUrl;
  $('preview-image').alt=next==='trace'?`${artInput.topic}的浅灰轮廓描绘版`:`${artInput.topic}彩色手抄报画稿`;
  $('color-tab').setAttribute('aria-selected',String(next==='color'));$('trace-tab').setAttribute('aria-selected',String(next==='trace'));
  $('preview-stage').classList.toggle('is-trace',next==='trace');$('trace-settings').hidden=next!=='trace';
  $('download-button').lastChild.textContent=next==='trace'?'下载描绘版':'下载画稿';
  $('result-tip').lastChild.textContent=next==='trace'?'白底浅灰轮廓，原图位置不变。可调线条深浅和粗细，打印后勾线、上色。':'先看彩色参考，再打印浅灰描绘版，沿轮廓勾线、自由上色。';
}
function showArtwork(url,input,isSample=false) {
  clearTrace();sourceUrl=url;artInput=input;
  $('art-title').textContent=input.topic;$('art-meta').textContent=`${grades[input.grade-1]} / ${styleNames[input.style]} / ${input.orientation==='portrait'?'竖版':'横版'}`;
  document.querySelector('.paper').classList.toggle('portrait',input.orientation==='portrait');$('sample-label').hidden=!isSample;setView('color');
}
function setBusy(busy) {
  $('generation-overlay').hidden=!busy;$('generate-button').disabled=busy;$('make-trace').disabled=busy;$('trace-tab').disabled=busy;$('download-button').disabled=busy;$('print-button').disabled=busy;
  $('trace-darkness').disabled=busy;$('trace-width').disabled=busy;
  $('generate-label').textContent=busy?'正在生成画稿…':'生成手抄报';
  $('generate-form').setAttribute('aria-busy',String(busy));
  clearInterval(clockTimer);
  if(busy)clockTimer=setInterval(()=>{const seconds=Math.max(0,Math.floor((Date.now()-(currentJob?.createdAt||Date.now()))/1000));$('progress-time').textContent=`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;},1000);
}
function renderJob(job) {
  currentJob=job;storePreference('handpaper-last-job',job.id);
  const running=['queued','generating'].includes(job.status);setBusy(running);
  $('progress-message').textContent=job.message;$('cancel-button').disabled=false;
  if(job.status==='completed'&&job.imageUrl) {showArtwork(job.imageUrl,job.input);$('job-notice').hidden=true;}
  else if(['failed','cancelled'].includes(job.status)) {$('job-notice').textContent=job.message;$('job-notice').hidden=false;}
  return running;
}
async function pollJob(id) {
  clearTimeout(pollTimer);
  try {const job=await api('/api/jobs/'+id);if(renderJob(job))pollTimer=setTimeout(()=>pollJob(id),2200);}
  catch(error){$('progress-message').textContent='连接暂时中断，正在重试…';pollTimer=setTimeout(()=>pollJob(id),5000);if(!csrf)setBusy(false);}
}
async function refreshStatus() {
  if(!csrf)return;
  try {
    const status=await api('/api/status');subscription=status.subscription;
    $('connect-button').classList.toggle('connected',subscription);
    $('connection-label').textContent=subscription?'本机订阅已连接':status.connected?'连接本机订阅':'本机服务待连接';
    if(subscription&&$('login-dialog').open){$('login-dialog').close();toast('订阅已连接，现在可以生成画稿。');}
    return status;
  } catch {subscription=false;$('connection-label').textContent='连接暂时中断';}
}
async function loadWorkspace() {
  const status=await refreshStatus();
  try {
    const {jobs}=await api('/api/jobs');
    const id=status?.activeJob||getPreference('handpaper-last-job');
    const job=jobs.find(j=>j.id===id)||jobs.find(j=>j.status==='completed');
    if(job){restoreInput(job.input);if(renderJob(job))pollJob(job.id);}
  } catch {}
}
const readImage=url=>new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error('画稿读取失败，请稍后重试。'));image.src=url;});
let traceRequestedAgain=false,traceRunning=false;
async function makeTrace() {
  if(currentJob&&['queued','generating'].includes(currentJob.status))return;
  if(traceRunning){traceRequestedAgain=true;return;}
  traceRunning=true;
  const revision=++traceRevision;
  $('make-trace').disabled=true;$('trace-tab').disabled=true;$('make-trace').lastChild.textContent='正在提取轮廓…';
  try {
    const image=await readImage(sourceUrl);const scale=Math.min(1,2400/Math.max(image.naturalWidth,image.naturalHeight));
    const width=Math.round(image.naturalWidth*scale),height=Math.round(image.naturalHeight*scale);
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const context=canvas.getContext('2d',{willReadFrequently:true});context.fillStyle='#fff';context.fillRect(0,0,width,height);context.drawImage(image,0,0,width,height);
    const pixels=context.getImageData(0,0,width,height).data;
    const result=await new Promise((resolve,reject)=>{pendingTrace={resolve,reject};worker.postMessage({pixels,width,height,darkness:Number($('trace-darkness').value),lineWidth:Number($('trace-width').value)},[pixels.buffer]);});
    context.putImageData(new ImageData(result.pixels,width,height),0,0);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    if(!blob)throw new Error('描绘版转换失败。');
    if(revision!==traceRevision)return;
    if(traceUrl)URL.revokeObjectURL(traceUrl);traceUrl=URL.createObjectURL(blob);setView('trace');toast('浅灰描绘版已更新，可调整线条深浅和粗细。');
  } catch(error){toast(error.message);}
  finally {traceRunning=false;const busy=currentJob&&['queued','generating'].includes(currentJob.status);$('make-trace').disabled=!!busy;$('trace-tab').disabled=!!busy;$('make-trace').lastChild.textContent='生成浅灰描绘版';if(traceRequestedAgain){traceRequestedAgain=false;makeTrace();}}
}

$('grade').replaceChildren(...grades.map((name,i)=>{const option=document.createElement('option');option.value=i+1;option.textContent=name;option.selected=i===6;return option;}));
restoreInput(getPreference('handpaper-settings'));updateComplexity();countNotes();
$('grade').addEventListener('change',updateComplexity);$('notes').addEventListener('input',countNotes);
$('generate-form').addEventListener('change',()=>storePreference('handpaper-settings',inputValue()));
document.querySelectorAll('[data-topic]').forEach(button=>button.addEventListener('click',()=>{
  $('topic').value=button.dataset.topic;
  if(!button.dataset.topic.includes('国庆'))$('notes').value='文字简洁，画面漂亮，适合当前年级学生手绘临摹。';
  else $('notes').value='画面大气，文字少，适合手绘。保留天安门、长城、山河和牡丹，细节不要太碎。';
  countNotes();storePreference('handpaper-settings',inputValue());
}));
$('generate-form').addEventListener('submit',async event=>{
  event.preventDefault();if(!csrf){toast('网站正在连接，请稍后再试。');return;}
  if(!subscription){$('login-dialog').showModal();return;}
  const input=inputValue();storePreference('handpaper-settings',input);$('generate-button').disabled=true;$('job-notice').hidden=true;
  try {const job=await api('/api/jobs',{method:'POST',body:input});renderJob(job);pollJob(job.id);$('result-title').scrollIntoView({behavior:'smooth',block:'start'});}
  catch(error){toast(error.message);$('generate-button').disabled=false;refreshStatus();}
});
$('cancel-button').addEventListener('click',async()=>{if(!currentJob)return;$('cancel-button').disabled=true;try{const job=await api('/api/jobs/'+currentJob.id+'/cancel',{method:'POST',body:{}});clearTimeout(pollTimer);renderJob(job);}catch(error){toast(error.message);$('cancel-button').disabled=false;}});
$('connect-button').addEventListener('click',()=>{$('login-description').textContent=subscription?'本机 Codex 订阅已经连接。生成会使用你的订阅额度。':'登录会保存在这台电脑上。网站调用本机 Codex 内置图片生成，使用你的订阅额度。';$('start-login').hidden=subscription;$('login-dialog').showModal();});
$('login-close').addEventListener('click',()=>$('login-dialog').close());
$('start-login').addEventListener('click',async()=>{
  $('start-login').disabled=true;$('login-error').textContent='';
  try {
    const login=await api('/api/login',{method:'POST',body:{}});
    const target=new URL(login.url);if(target.protocol!=='https:'||!['auth.openai.com','chatgpt.com'].includes(target.hostname))throw new Error('授权地址无效，请在电脑终端运行 codex login。');
    $('login-code').textContent=login.code||'';$('login-link').href=login.url;$('login-code-area').hidden=false;$('start-login').hidden=true;
  }catch(error){$('login-error').textContent=error.message+' 也可以在电脑终端运行 codex login 完成登录。';}
  finally{$('start-login').disabled=false;}
});
setInterval(refreshStatus,15000);
$('make-trace').addEventListener('click',makeTrace);$('trace-tab').addEventListener('click',()=>traceUrl?setView('trace'):makeTrace());$('color-tab').addEventListener('click',()=>setView('color'));
let traceDelay;
function updateTraceControls() {
  const lineWidth=Number($('trace-width').value);
  $('trace-percent').textContent=$('trace-darkness').value+'%';
  $('trace-width-label').textContent=`${traceWidthNames[lineWidth-1]} · ${lineWidth}档`;
  $('trace-width').setAttribute('aria-valuetext',`${traceWidthNames[lineWidth-1]}，${lineWidth}档`);
}
for(const id of ['trace-darkness','trace-width'])$(id).addEventListener('input',()=>{
  updateTraceControls();traceRevision++;clearTimeout(traceDelay);traceDelay=setTimeout(makeTrace,250);
});
$('download-button').addEventListener('click',async()=>{
  try {const response=await fetch(view==='trace'?traceUrl:sourceUrl);if(!response.ok)throw new Error('画稿下载失败。');const blob=await response.blob();const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`${artInput.topic.replace(/[\\/:*?"<>|]/g,'_')}-${view==='trace'?'浅灰描绘版':'彩色画稿'}.${blob.type==='image/jpeg'?'jpg':blob.type==='image/webp'?'webp':'png'}`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);}
  catch(error){toast(error.message);}
});
$('print-button').addEventListener('click',()=>window.print());
async function initialize() {
  if(location.hash.startsWith('#access='))history.replaceState(null,'',location.pathname+location.search);
  try {const session=await api('/api/session');csrf=session.csrf;await loadWorkspace();}
  catch{toast('本机网站服务暂时无法连接，请刷新重试。');}
}
initialize();

// These optional browser tools use the same form state and image conversion as the UI.
if(document.modelContext?.registerTool) {
  const lifecycle=new AbortController();
  window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
  const tools=[{
    name:'configure_handpaper',title:'设置手抄报画稿',
    description:'Set the visible topic, grade, style, orientation and notes. This stages the form only; it does not generate an image or consume subscription usage.',
    inputSchema:{type:'object',properties:{topic:{type:'string',minLength:1,maxLength:60},grade:{type:'integer',minimum:1,maximum:12},style:{type:'string',enum:Object.keys(styleNames)},orientation:{type:'string',enum:['landscape','portrait']},notes:{type:'string',maxLength:1200}},required:['topic','grade','style','orientation'],additionalProperties:false},
    annotations:{readOnlyHint:false,untrustedContentHint:false},
    execute(input){
      if(!input||typeof input.topic!=='string'||!input.topic.trim()||input.topic.length>60||!Number.isInteger(input.grade)||input.grade<1||input.grade>12||!Object.hasOwn(styleNames,input.style)||!['landscape','portrait'].includes(input.orientation)||typeof (input.notes??'')!=='string'||(input.notes??'').length>1200)throw new Error('手抄报设置无效。');
      restoreInput({...input,notes:input.notes??''});storePreference('handpaper-settings',inputValue());return {settings:inputValue(),complexity:$('complexity-title').textContent};
    }
  },{
    name:'create_handpaper_tracing',title:'生成浅灰描绘版',
    description:'Convert the currently displayed color handpaper into pale gray outlines and switch the visible preview. Runs locally in the browser and consumes no subscription usage.',
    inputSchema:{type:'object',properties:{darkness:{type:'integer',minimum:10,maximum:50},lineWidth:{type:'integer',minimum:1,maximum:5}},additionalProperties:false},
    annotations:{readOnlyHint:false,untrustedContentHint:false},
    async execute(input){
      if(currentJob&&['queued','generating'].includes(currentJob.status))throw new Error('请等待彩色画稿完成。');
      if(traceRunning)throw new Error('描绘版正在更新，请稍后再试。');
      if(input?.darkness!==undefined&&(!Number.isInteger(input.darkness)||input.darkness<10||input.darkness>50))throw new Error('线条深浅需为10至50。');
      if(input?.lineWidth!==undefined&&(!Number.isInteger(input.lineWidth)||input.lineWidth<1||input.lineWidth>5))throw new Error('线条粗细需为1至5档。');
      if(input?.darkness!==undefined)$('trace-darkness').value=input.darkness;
      if(input?.lineWidth!==undefined)$('trace-width').value=input.lineWidth;
      updateTraceControls();clearTimeout(traceDelay);await makeTrace();
      if(view!=='trace')throw new Error('描绘版生成失败。');
      return {version:'tracing',darkness:Number($('trace-darkness').value),lineWidth:Number($('trace-width').value),topic:artInput.topic};
    }
  }];
  for(const tool of tools){try{Promise.resolve(document.modelContext.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});}catch{}}
}
