const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9334;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function launch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
  const proc = spawn(CHROME, ['--headless=new','--disable-gpu','--no-sandbox','--disable-dev-shm-usage',`--remote-debugging-port=${PORT}`,`--user-data-dir=${dir}`,'about:blank'], { stdio: 'ignore' });
  for (let i=0;i<60;i++){ try{ if((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) return {proc,dir}; }catch{} await sleep(250); }
  throw new Error('no chrome');
}
class CDP {
  constructor(ws){ this.ws=ws; this.id=0; this.pending=new Map(); }
  static async connect(u){ const ws=new WebSocket(u); await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;}); const c=new CDP(ws);
    ws.onmessage = ev => { const m=JSON.parse(ev.data); if(m.id&&c.pending.has(m.id)){const p=c.pending.get(m.id);c.pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);} };
    return c; }
  send(method,params={}){ const id=++this.id; return new Promise((res,rej)=>{ this.pending.set(id,{resolve:res,reject:rej}); this.ws.send(JSON.stringify({id,method,params})); }); }
  async eval(e){ const r=await this.send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true}); if(r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text); return r.result?.value; }
}
(async()=>{
  const start = process.argv[2];
  const {proc,dir} = await launch();
  try{
    const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`,{method:'PUT'})).json();
    const c = await CDP.connect(t.webSocketDebuggerUrl);
    await c.send('Page.enable'); await c.send('Runtime.enable');
    await c.send('Page.navigate',{url:start});
    await sleep(5000);
    console.log('BEFORE', await c.eval('location.href'));
    console.log('HAS_BTN', await c.eval('!!document.querySelector("#verify_btn")'));
    await c.eval(`(()=>{ window.__opened=[]; const o=window.open; window.open=function(u,...a){window.__opened.push(u); return o.call(window,u,...a);}; document.querySelector('#verify_btn')?.click(); return true; })()`);
    await sleep(12000);
    console.log('AFTER', await c.eval('location.href'));
    console.log('OPENED', await c.eval('JSON.stringify(window.__opened||[])'));
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    console.log('TARGETS', list.map(x=>x.type+' '+x.url).join('\n'));
    for (const x of list) {
      if (x.type !== 'page') continue;
      const cc = await CDP.connect(x.webSocketDebuggerUrl);
      const html = await cc.eval('document.documentElement.outerHTML').catch(()=>'');
      const links = [...new Set([...String(html).matchAll(/href="([^"]+)"/g)].map(m=>m[1]))].filter(u=>/hubcloud|r2\.|pixel|download|\.zip|\.mkv/i.test(u));
      console.log('==', x.url, 'len', String(html).length, 'links', links.slice(0,8));
      cc.ws.close();
    }
  } finally { try{proc.kill();}catch{} }
})().catch(e=>{console.error(e);process.exit(1);});
