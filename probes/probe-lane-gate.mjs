import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const appData = process.env.APPDATA || path.join(os.homedir(),'AppData','Roaming');
const sp=[process.env.PERCH_CLI_AUTH_DIR&&path.join(process.env.PERCH_CLI_AUTH_DIR,'cli-auth-session.json'),path.join(os.homedir(),'.perch','cli-auth-session.json'),path.join(appData,'Perch AI Desktop','cli-auth-session.json')].filter(Boolean).find(p=>fs.existsSync(p));
const s=JSON.parse(fs.readFileSync(sp,'utf8')); const appUrl=(s.appUrl||'https://app.perchai.app').replace(/\/+$/,'');
const H={Authorization:`Bearer ${s.accessToken}`,'Content-Type':'application/json','User-Agent':'perchai-cli/2.4.118','x-perch-locale':'en'};
for(const lane of ['code','worker','chat','plan','research','fast']){
  const r=await fetch(`${appUrl}/api/perch-terminal/model-call`,{method:'POST',headers:{...H,Accept:'text/event-stream'},body:JSON.stringify({
    request:{messages:[{role:'user',content:'In one sentence: who are you?'}],maxTokens:60},
    runId:`pl-${Date.now()}-${lane}`,lane,strictManual:false,clientSurface:'cli',
    attribution:{userId:s.userId,source:'cli',lane},preferredModelId:'openrouter-qwen-qwen3-8-max-0902',manualModelOptionId:'openrouter-qwen-qwen3-8-max-0902'})});
  let a='',m='',e='';
  if((r.headers.get('content-type')||'').includes('text/event-stream')){const rd=r.body.getReader();const dc=new TextDecoder();let b='';outer:while(1){const{value,done}=await rd.read();if(done)break;b+=dc.decode(value,{stream:true});const fr=b.split('\n\n');b=fr.pop()??'';for(const f of fr)for(const l of f.split('\n')){if(!l.startsWith('data:'))continue;let ev=null;try{ev=JSON.parse(l.slice(5).trim())}catch{continue}if(ev.type==='done'){a=ev.text||'';m=ev.model||'';break outer}}}}
  else {const p=await r.json().catch(()=>({}));e=p.errorCode||p.error||'';}
  console.log(`${lane.padEnd(9)} ${r.status} ${m||'-'} ${e?('err='+String(e).slice(0,40)):''} | ${a.replace(/\s+/g,' ').slice(0,90)}`);
  await new Promise(x=>setTimeout(x,1200));
}
