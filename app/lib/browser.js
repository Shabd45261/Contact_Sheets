'use strict';
/* Zero-dependency headless Chrome driver (CDP over WebSocket) used only for
   JS-gated "mediator" pages (4KHDHub -> greenmotors -> hubcloud). */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sleep } = require('./util');

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  // Host install exposed through the sandbox drive mapping (CHROME_PATH wins).
  'C:\\HostDrives\\C\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\HostDrives\\C\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\HostDrives\\C\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\HostDrives\\C\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
function chromePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  return CANDIDATES.find(p => fs.existsSync(p)) || null;
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cdp connect failed')); });
    const c = new CDP(ws);
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && c.pending.has(m.id)) {
        const p = c.pending.get(m.id); c.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      } else if (m.method) for (const fn of c.listeners) fn(m);
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
  on(fn) { this.listeners.push(fn); }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

class Browser {
  constructor() { this.proc = null; this.port = 0; this.dir = null; this.ready = null; }

  async start() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const exe = chromePath();
      if (!exe) throw new Error('No Chrome/Edge found. Set CHROME_PATH to a Chromium browser.');
      this.port = 9411 + Math.floor(Math.random() * 300);
      this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-browser-'));
      this.proc = spawn(exe, [
        '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
        '--disable-background-networking', '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding', '--mute-audio', '--no-first-run',
        '--no-default-browser-check', '--disable-extensions',
        `--remote-debugging-port=${this.port}`, `--user-data-dir=${this.dir}`, 'about:blank',
      ], { stdio: 'ignore' });
      this.proc.on('exit', () => { this.ready = null; this.proc = null; });
      for (let i = 0; i < 80; i++) {
        try { if ((await fetch(`http://127.0.0.1:${this.port}/json/version`)).ok) return true; } catch {}
        await sleep(250);
      }
      throw new Error('headless browser did not start');
    })();
    return this.ready;
  }

  async open(url = 'about:blank') {
    await this.start();
    const t = await (await fetch(`http://127.0.0.1:${this.port}/json/new?about:blank`, { method: 'PUT' })).json();
    const cdp = await CDP.connect(t.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    if (url && url !== 'about:blank') await cdp.send('Page.navigate', { url });
    return { cdp, tabId: t.id };
  }

  async closeTab(tabId) {
    try { await fetch(`http://127.0.0.1:${this.port}/json/close/${tabId}`); } catch {}
  }

  /* Navigate a mediator page, press its verify button, return outbound links. */
  async mediator(url, { clickSelector = '#verify_btn', waitLink = /hubcloud/i, timeout = 25000 } = {}) {
    const { cdp, tabId } = await this.open(url);
    try {
      const started = Date.now();
      let clicked = false;
      let lastHref = '';
      while (Date.now() - started < timeout) {
        await sleep(1500);
        lastHref = (await cdp.eval('location.href').catch(() => '')) || lastHref;
        const found = await cdp.eval(`(() => {
          const a = [...document.querySelectorAll('a[href]')].map(x => x.href).filter(h => ${waitLink}.test(h));
          return a.length ? a[0] : '';
        })()`).catch(() => '');
        if (found) return { url: found, href: lastHref };
        if (!clicked) {
          const ok = await cdp.eval(`(() => { const el = document.querySelector(${JSON.stringify(clickSelector)}); if(!el) return false; el.click(); return true; })()`).catch(() => false);
          clicked = !!ok;
        }
        // After clicking, some mediators need a fresh page load
        if (clicked && Date.now() - started > 4000 && !lastHref.includes('homelander') && lastHref !== url) {
          await cdp.send('Page.navigate', { url: lastHref }).catch(() => {});
        }
      }
      const domHrefs = await cdp.eval(`(() => [...document.querySelectorAll('a[href]')].map(a => a.href))()`).catch(() => []);
      const match = (domHrefs || []).find(h => waitLink.test(h));
      return { url: match || '', href: lastHref };
    } finally {
      cdp.close();
      await this.closeTab(tabId);
    }
  }

  stop() {
    try { if (this.proc) this.proc.kill(); } catch {}
    this.proc = null; this.ready = null;
    try { if (this.dir) fs.rmSync(this.dir, { recursive: true, force: true }); } catch {}
  }
}

let shared = null;
function getBrowser() { if (!shared) shared = new Browser(); return shared; }
process.on('exit', () => { if (shared) shared.stop(); });

module.exports = { Browser, getBrowser, chromePath };
