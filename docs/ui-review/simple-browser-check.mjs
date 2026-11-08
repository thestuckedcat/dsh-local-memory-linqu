// Offline synthetic UI checks. No DSH, provider or daily browser profile.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
const output=path.dirname(fileURLToPath(import.meta.url));
const input=path.join(output,'memory-simple-review.html');
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const inputSha256=sha(input);
const markup=fs.readFileSync(input,'utf8');
for(const m of markup.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(m[1]);
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'codex-memory-simple-'));
const browser=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',[
  '--headless=new','--remote-debugging-port=0','--disable-background-networking',
  '--disable-component-update','--disable-sync','--disable-extensions',
  '--disable-default-apps','--no-first-run','--metrics-recording-only',
  '--host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE localhost',`--user-data-dir=${profile}`,'about:blank'
],{windowsHide:true,stdio:['ignore','ignore','pipe']});
const results={client_date:'2026-11-08',scope:'MEM-EXP-1 synthetic prototype only',inputSha256,checks:[],exceptions:[],httpRequests:[],screenshots:[]};
let ws;
try{
  const url=await new Promise((resolve,reject)=>{
    let log='';const timer=setTimeout(()=>reject(new Error('Browser start timed out')),12000);
    browser.once('error',reject);browser.once('exit',code=>{clearTimeout(timer);reject(new Error(`Browser exited ${code}: ${log.slice(-600)}`));});
    browser.stderr.on('data',b=>{log+=b;const m=log.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m){clearTimeout(timer);resolve(m[1]);}});
  });
  ws=new WebSocket(url);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  let serial=0;const pending=new Map();
  ws.addEventListener('message',event=>{
    const m=JSON.parse(event.data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}}
    else if(m.method==='Runtime.exceptionThrown')results.exceptions.push(m.params.exceptionDetails.text);
    else if(m.method==='Network.requestWillBeSent'&&/^https?:/.test(m.params.request.url))results.httpRequests.push(m.params.request.url);
  });
  const rpc=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
    const id=++serial;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout ${method}`));},7000);
    pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
  });
  const target=await rpc('Target.createTarget',{url:'about:blank'});
  const {sessionId}=await rpc('Target.attachToTarget',{targetId:target.targetId,flatten:true});
  const call=(m,p={})=>rpc(m,p,sessionId);
  const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);return r.result.value;};
  const check=async(name,expression)=>{const observed=await evaluate(expression);results.checks.push({name,pass:observed===true||observed?.pass===true,observed});};
  const viewport=async(width,dark=false,mobile=false)=>{
    await call('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile});
    await call('Emulation.setTouchEmulationEnabled',{enabled:mobile,maxTouchPoints:1});
    await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:dark?'dark':'light'}]});
  };
  const shot=async name=>{const r=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(output,name),Buffer.from(r.data,'base64'));results.screenshots.push(name);};
  await call('Page.enable');await call('Runtime.enable');await call('Network.enable');
  await call('Network.setBlockedURLs',{urls:['http://*','https://*','ws://*','wss://*']});
  await viewport(1180);await call('Page.navigate',{url:pathToFileURL(input).href});
  await evaluate("new Promise(r=>document.readyState==='complete'?r(true):addEventListener('load',()=>r(true),{once:true}))");
  await check('readable_memory_list',"document.querySelectorAll('[data-record]').length===3&&document.querySelector('[data-detail-body]').textContent.includes('6.1')");
  await check('no_manual_management_workflow',"!document.querySelector('input[type=checkbox]')&&!/选批次|发布候选|审核候选/.test(document.body.innerText)");
  await check('status_bar_and_no_process_dump',"!!document.querySelector('[role=status]')&&!document.querySelector('.ms-chat details')");
  await check('footer_character_limit',"({lengths:[...document.querySelectorAll('[data-footer]')].map(n=>Array.from(n.textContent).length),pass:[...document.querySelectorAll('[data-footer]')].every(n=>Array.from(n.textContent).length<=100)})");
  await evaluate("document.querySelector('[data-memory=M2]').click()");
  await check('citation_opens_corresponding_memory',"document.querySelector('[data-detail-title]').textContent==='跨仓测试记录'&&document.activeElement.dataset.record==='M2'");
  await evaluate("document.querySelector('[data-tab=annual]').click()");
  await check('annual_separate_and_sourced',"!document.querySelector('#ms-annual').hidden&&document.querySelector('#ms-experience').hidden&&document.querySelector('#ms-annual').textContent.includes('来源')");
  await evaluate("document.querySelector('[data-tab=experience]').click();document.querySelector('[data-record=M1]').click()");
  await shot('simple-desktop.png');
  await evaluate("document.querySelector('input').value='记1没有改成6.6，当前仍是6.1';document.querySelector('form').requestSubmit()");
  await check('negation_not_misread_as_correction',"document.querySelector('[data-next]').hidden&&document.querySelector('[data-detail-body]').textContent.includes('6.1')&&document.querySelector('[data-status]').textContent.includes('未修改')");
  await evaluate("document.querySelector('input').value='记1已过时：当前目标内核已改为6.6。';document.querySelector('form').requestSubmit()");
  await check('updating_bar_only',"document.querySelector('[data-status]').textContent==='正在更新记忆…'&&document.querySelector('[data-next]').hidden");
  await evaluate("new Promise(r=>setTimeout(r,750))");
  await check('correction_updates_memory',"document.querySelector('[data-detail-body]').textContent.includes('6.6')&&document.querySelector('[data-status]').textContent==='记忆已更正'&&!document.querySelector('[data-next]').hidden");
  await check('new_answer_uses_current_version',"document.querySelector('[data-next] .ms-answer').textContent.includes('6.6')&&!document.querySelector('[data-next] .ms-answer').textContent.includes('6.1')");
  await evaluate("document.querySelector('.ms-answer [data-memory=M1]').click()");
  await check('old_reference_retains_provenance',"document.querySelector('[data-history]').open&&document.querySelector('[data-history]').textContent.includes('v1')&&document.querySelector('[data-history]').textContent.includes('11月7日')&&document.querySelector('[data-history]').textContent.includes('v2')");
  await check('no_reflection_dump_in_chat',"!document.querySelector('.ms-chat').textContent.includes('其他原因未确定')&&document.querySelector('[data-detail-source]').textContent.includes('用户纠正')");
  await shot('simple-corrected.png');
  for(const width of [320,760,1024]){
    await viewport(width,false,width===320);
    await check(`fits_${width}`,"document.documentElement.scrollWidth<=innerWidth+1");
    if(width===320){
      await check('mobile_input_readable',"parseFloat(getComputedStyle(document.querySelector('input')).fontSize)>=16");
      await shot('simple-mobile.png');
    }
  }
  await viewport(1180,true);await shot('simple-dark.png');
  await rpc('Browser.close').catch(()=>{});
}catch(error){results.failure=String(error.message);}finally{
  try{ws?.close();}catch{}
  if(browser.exitCode===null){await new Promise(r=>setTimeout(r,700));if(browser.exitCode===null)browser.kill();}
  const full=path.resolve(profile);
  if(path.dirname(full)===path.resolve(os.tmpdir())&&path.basename(full).startsWith('codex-memory-simple-')){
    try{fs.rmSync(full,{recursive:true,force:true});results.tempProfileCleanup=true;}catch{results.tempProfileCleanup=false;}
  }
  results.inputUnchanged=sha(input)===inputSha256;
  results.noLiveHostOrBusinessApi=true;
  results.limits=['Synthetic offline UI only; no live plugin integration or model quality verification.','No page HTTP requests does not certify OS/browser egress.'];
  results.verified=results.inputUnchanged&&!results.failure&&!results.exceptions.length&&!results.httpRequests.length&&results.checks.length===16&&results.checks.every(c=>c.pass);
  fs.writeFileSync(path.join(output,'simple-browser-check.json'),JSON.stringify(results,null,2)+'\n');
  console.log(JSON.stringify(results,null,2));if(!results.verified)process.exitCode=1;
}
