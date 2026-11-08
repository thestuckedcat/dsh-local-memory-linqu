// Offline synthetic prototype validation; never opens the user's browser profile or DSH.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {pathToFileURL, fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {createHash} from 'node:crypto';

const output=path.dirname(fileURLToPath(import.meta.url));
const input=path.join(output,'memory-center-review.html');
const markup=fs.readFileSync(input,'utf8');
const inputSha256=createHash('sha256').update(fs.readFileSync(input)).digest('hex');
for(const [i,m] of [...markup.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].entries())
  new vm.Script(m[1],{filename:`prototype-inline-${i}`});
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'codex-memory-ui-'));
const browser=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',[
  '--headless=new','--remote-debugging-port=0','--disable-background-networking',
  '--disable-component-update','--disable-sync','--disable-extensions',
  '--disable-default-apps','--no-first-run','--metrics-recording-only',
  '--host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE localhost',`--user-data-dir=${profile}`,'about:blank'
],{windowsHide:true,stdio:['ignore','ignore','pipe']});
let ws;
const results={client_date:'2026-11-08',scope:'isolated synthetic UI only',inputSha256,scriptParse:true,
  checks:[],exceptions:[],httpRequests:[],screenshots:[]};
try{
  const url=await new Promise((resolve,reject)=>{
    let log='';const timer=setTimeout(()=>reject(new Error('Browser start timed out')),12000);
    browser.once('error',reject);
    browser.stderr.on('data',b=>{log+=b;const m=log.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if(m){clearTimeout(timer);resolve(m[1]);}});
  });
  ws=new WebSocket(url);
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  let serial=0;const pending=new Map();
  ws.addEventListener('message',event=>{
    const m=JSON.parse(event.data);
    if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}}
    else if(m.method==='Runtime.exceptionThrown')results.exceptions.push(m.params.exceptionDetails.text);
    else if(m.method==='Network.requestWillBeSent'&&/^https?:/.test(m.params.request.url))results.httpRequests.push(m.params.request.url);
  });
  const rpc=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
    const id=++serial;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout ${method}`));},7000);
    pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
  });
  const target=await rpc('Target.createTarget',{url:'about:blank'});
  const {sessionId}=await rpc('Target.attachToTarget',{targetId:target.targetId,flatten:true});
  const call=(method,params={})=>rpc(method,params,sessionId);
  const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);return r.result.value;};
  await call('Page.enable');await call('Runtime.enable');await call('Network.enable');
  await call('Network.setBlockedURLs',{urls:['http://*','https://*','ws://*','wss://*']});
  const viewport=async(width,height,dark=false,mobile=false)=>{
    await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile});
    await call('Emulation.setTouchEmulationEnabled',{enabled:mobile,maxTouchPoints:1});
    await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:dark?'dark':'light'}]});
  };
  const shot=async name=>{const r=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    fs.writeFileSync(path.join(output,name),Buffer.from(r.data,'base64'));results.screenshots.push(name);};
  const check=async(name,expression)=>{const value=await evaluate(expression);
    results.checks.push({name,pass:typeof value==='boolean'?value:value.pass===true,observed:value});};
  await viewport(1180,940);await call('Page.navigate',{url:pathToFileURL(input).href});
  await evaluate("new Promise(r=>{if(document.readyState==='complete')r(true);else addEventListener('load',()=>r(true),{once:true})})");
  await check('reading_initial',"({tabs:document.querySelectorAll('#mc-reading [data-tab]').length,rows:document.querySelectorAll('#mc-reading [data-record]').length,pass:document.querySelectorAll('#mc-reading [data-tab]').length===4&&!!document.querySelector('#mc-reading [data-control=detail]').textContent.trim()&&document.documentElement.scrollWidth<=innerWidth+1})");
  await shot('desktop-reading.png');
  await evaluate("document.querySelector('#mc-reading [data-record=DEMO-E02]').click()");
  await check('record_selection',"document.querySelector('#mc-reading [data-control=detail]').textContent.includes('缓冲区')");
  await evaluate("{const q=document.querySelector('#mc-reading [data-control=search]');q.value='缓冲区释放前';q.dispatchEvent(new Event('input',{bubbles:true}));}");
  await check('search_filters_rows',"document.querySelectorAll('#mc-reading [data-record]').length===1");
  await evaluate("{const q=document.querySelector('#mc-reading [data-control=search]');q.value='';q.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#mc-reading [data-action=organize]').click();}");
  await check('candidate_diff',"document.querySelector('#mc-reading [data-control=detail]').textContent.includes('整理')");
  await shot('candidate-review.png');
  await evaluate("document.querySelector('[data-direction=紧凑管理]').click()");
  await check('compact_direction',"!document.querySelector('[data-variant=紧凑管理]').hidden&&document.querySelectorAll('#mc-managing table').length>0");
  await shot('desktop-compact.png');
  await viewport(320,940,false,true);
  await check('compact_mobile_fits',"({viewport:innerWidth,scroll:document.documentElement.scrollWidth,pass:document.documentElement.scrollWidth<=innerWidth+1})");
  await shot('mobile-compact.png');
  await evaluate("{const c=document.querySelector('#mc-managing [data-check=DEMO-E01]');c.checked=true;c.dispatchEvent(new Event('change',{bubbles:true}));const q=document.querySelector('#mc-managing [data-control=search]');q.value='缓冲区释放前';q.dispatchEvent(new Event('input',{bubbles:true}));}");
  await check('hidden_selection_cleared',"document.querySelector('#mc-managing [data-action=selected]').disabled&&document.querySelector('#mc-managing .mc-batch').textContent.includes('已选 0 条')");
  await check('mobile_editable_font',"parseFloat(getComputedStyle(document.querySelector('#mc-managing [data-control=search]')).fontSize)>=16");
  await evaluate("{const c=document.querySelector('#mc-managing [data-check=DEMO-E02]');c.checked=true;c.dispatchEvent(new Event('change',{bubbles:true}));const b=document.querySelector('#mc-managing [data-action=selected]');b.focus();b.click();}");
  await check('batch_open_focus',"document.activeElement===document.querySelector('#mc-managing [data-action=back]')&&document.activeElement.getBoundingClientRect().width>0");
  await evaluate("document.querySelector('#mc-managing [data-action=back]').click()");
  await check('back_preserves_filter',"document.querySelector('#mc-managing [data-control=search]').value==='缓冲区释放前'&&document.activeElement.dataset.record==='DEMO-E02'");
  await evaluate("window.dispatchEvent(new CustomEvent('openai:set_globals',{detail:{globals:{widgetState:{privateContent:{'mc-managing':{tab:'experience',selected:'DEMO-E04',query:'',filter:'已归档',detailOpen:false}}}}}}))");
  await check('snapshot_filter_restored',"document.querySelector('#mc-managing [data-control=filter]').value==='已归档'&&document.querySelectorAll('#mc-managing .mc-list-panel [data-record]').length===1");
  await evaluate("document.querySelector('[data-direction=清爽阅读]').click();document.querySelector('#mc-reading [data-tab=experience]').click();document.querySelector('#mc-reading [data-record=DEMO-E02]').click()");
  await check('mobile_detail',"({open:document.querySelector('#mc-reading').classList.contains('mc-detail-open'),pass:document.querySelector('#mc-reading').classList.contains('mc-detail-open')&&!!document.querySelector('#mc-reading [data-action=back]')&&document.documentElement.scrollWidth<=innerWidth+1})");
  await shot('mobile-detail.png');
  await evaluate("document.querySelector('#mc-reading [data-action=back]').click();const b=document.querySelector('#mc-reading [data-action=organize]');b.focus();b.click()");
  await check('organize_open_focus',"document.activeElement===document.querySelector('#mc-reading [data-action=back]')&&document.activeElement.getBoundingClientRect().width>0");
  await check('candidate_sources_closed',"{const d=document.querySelector('#mc-reading [data-control=detail]').textContent;d.includes('DEMO-E03')&&d.includes('DEMO-E05')&&d.includes('先记录构建标识和运行产物')}");
  await check('detail_toolbar_collapsed',"getComputedStyle(document.querySelector('#mc-reading .mc-toolbar')).display==='none'");
  await evaluate("document.querySelector('#mc-reading [data-tab=experience]').click()");
  for(const width of [760,1024]){
    await viewport(width,940,false,false);
    await check(`reading_width_${width}`,"document.documentElement.scrollWidth<=innerWidth+1");
    await evaluate("document.querySelector('[data-direction=紧凑管理]').click();document.querySelector('#mc-managing [data-tab=experience]').click()");
    await check(`compact_width_${width}`,"document.documentElement.scrollWidth<=innerWidth+1");
    await evaluate("document.querySelector('[data-direction=清爽阅读]').click()");
  }
  await viewport(1180,940,true,false);await evaluate("document.querySelector('#mc-reading [data-tab=experience]').click();window.scrollTo(0,0)");
  await shot('desktop-dark.png');
  await rpc('Browser.close').catch(()=>{});
}catch(error){results.failure=String(error.message);}finally{
  try{ws?.close();}catch{}
  if(browser.exitCode===null){await new Promise(r=>setTimeout(r,700));if(browser.exitCode===null)browser.kill();}
  const full=path.resolve(profile);
  if(path.dirname(full)===path.resolve(os.tmpdir())&&path.basename(full).startsWith('codex-memory-ui-')){
    try{fs.rmSync(full,{recursive:true,force:true});results.tempProfileCleanup=true;}catch{results.tempProfileCleanup=false;}
  }
  results.noLiveHostOrBusinessApi=true;
  results.inputUnchanged=createHash('sha256').update(fs.readFileSync(input)).digest('hex')===inputSha256;
  results.limits=['Synthetic offline prototype only; no live plugin/UI or Host integration acceptance.','No page HTTP requests were observed; this does not certify OS or whole-browser egress.'];
  results.verified=results.inputUnchanged&&!results.failure&&!results.exceptions.length&&!results.httpRequests.length&&results.checks.length>=19&&results.checks.every(c=>c.pass);
  fs.writeFileSync(path.join(output,'browser-check.json'),JSON.stringify(results,null,2)+'\n');
  console.log(JSON.stringify(results,null,2));
  if(!results.verified)process.exitCode=1;
}
