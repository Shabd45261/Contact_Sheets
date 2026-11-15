// Minimal CDP driver (no deps) for probing JS-gated download pages.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function launch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
  const proc = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--disable-background-networking', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, 'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return { proc, dir };
    } catch {}
    await sleep(250);
  }
  throw new Error('chrome did not start');
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && c.pending.has(msg.id)) {
        const { resolve, reject } = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
      } else if (msg.method) c.events.push(msg);
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

(async () => {
  const start = process.argv[2] || 'https://greenmotors.club/?id=Q1dxTzFnbjhrQm5kMG5lL01tQzcvaGpOVUFvQzMwd0g4Y3NkMzB1NWczMjNRUWpsQW9IbHJVVC9Fb3U3eDRrR3QzcDRCb0NqZjlna21uNjBIc0hyU0E9PQ==';
  const { proc, dir } = await launch();
  try {
    const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    const cdp = await CDP.connect(t.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    const media = [];
    const origHandler = cdp.ws.onmessage;
    cdp.ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.method === 'Network.requestWillBeSent') {
        const u = msg.params?.request?.url || '';
        if (/\.(mp4|mkv|m3u8|zip)(\?|$)|hubcloud|r2\.dev|pixeldrain/i.test(u)) media.push(u.slice(0, 300));
      }
      if (msg.id && cdp.pending.has(msg.id)) {
        const { resolve, reject } = cdp.pending.get(msg.id); cdp.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
      }
    };
    await cdp.send('Page.navigate', { url: start });
    await sleep(6000);
    console.log('URL1', await cdp.eval('location.href'));
    console.log('TEXT1', (await cdp.eval('document.body.innerText'))?.slice(0, 400));
    // click any element whose text mentions continue/verify/download
    const clicked = await cdp.eval(`(() => {
      const els = [...document.querySelectorAll('a,button,div,span')];
      const el = els.find(e => /click to continue|continue|verify|download/i.test(e.innerText||'') && (e.offsetWidth||e.offsetHeight));
      if (!el) return null;
      el.click();
      return (el.innerText||'').slice(0,80);
    })()`);
    console.log('CLICKED', clicked);
    await sleep(8000);
    console.log('URL2', await cdp.eval('location.href'));
    const dom = await cdp.eval('document.documentElement.outerHTML');
    fs.writeFileSync('data/intel/cdp_dom.html', dom);
    console.log('LINKS', [...new Set([...dom.matchAll(/href="([^"]+)"/g)].map(m => m[1]))].filter(u => /hubcloud|r2|pixel|download|green/i.test(u)).slice(0, 20));
    console.log('MEDIA', [...new Set(media)].slice(0, 20));
    cdp.close();
  } finally {
    try { proc.kill(); } catch {}
  }
})().catch(e => { console.error(e); process.exit(1); });
