'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
const UA_MOBILE = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function request(url, opts = {}) {
  const headers = { 'user-agent': opts.ua || UA_DESKTOP, accept: opts.accept || '*/*', ...(opts.headers || {}) };
  let lastErr;
  const attempts = opts.retries == null ? 2 : opts.retries;
  for (let i = 0; i <= attempts; i++) {
    try {
      const r = await fetch(url, {
        method: opts.method || 'GET',
        headers,
        body: opts.body,
        redirect: 'follow',
        signal: AbortSignal.timeout(opts.timeout || 40000),
      });
      const buf = Buffer.from(await r.arrayBuffer());
      return {
        status: r.status,
        ok: r.ok,
        url: r.url || url,
        headers: Object.fromEntries(r.headers.entries()),
        buffer: buf,
        text: buf.toString('utf8'),
        json: () => JSON.parse(buf.toString('utf8')),
      };
    } catch (e) {
      lastErr = e;
      if (i < attempts) await sleep(500 * (i + 1));
    }
  }
  throw lastErr;
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function absolute(base, href) {
  try { return new URL(decodeEntities(href), base).toString(); } catch { return href; }
}

function slugify(s, max = 80) {
  const out = String(s || '').normalize('NFKD').replace(/[^\w\s.-]/g, '').trim()
    .replace(/[\s.]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return (out || 'untitled').slice(0, max);
}

function secondsToLabel(sec) {
  const s = Math.max(0, sec);
  if (s >= 3600) {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = Math.floor(s % 60);
    return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  }
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

function titleFromSlug(slug) {
  const stop = /^(download|watch|free|full|movie|series|web|dl|hdrip|bluray|dual|audio|hindi|dubbed|english|with|subtitles?|subs?|esubs?|480p|720p|1080p|2160p|4k|x264|x265|hevc|avc|aac|ddp5|1|h264|h265|webrip|web-dl|org|com|net)$/i;
  const words = decodeURIComponent(slug).replace(/[-_]+/g, ' ').replace(/\.(html?|php)$/i, ' ').split(/\s+/)
    .filter(w => w && !stop.test(w));
  const t = words.join(' ').trim();
  return t ? t.replace(/\b\w/g, c => c.toUpperCase()).slice(0, 90) : decodeURIComponent(slug);
}

function sanitizeName(s, max = 90) {
  return String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) || 'Untitled';
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }

function shortHash(s) { return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16); }

function parseSizeToBytes(txt) {
  const m = String(txt || '').match(/([\d.]+)\s*(TB|GB|MB|KB)/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const mult = { TB: 1e12, GB: 1e9, MB: 1e6, KB: 1e3 }[m[2].toUpperCase()];
  return Math.round(n * mult);
}

module.exports = { UA_DESKTOP, UA_MOBILE, sleep, request, decodeEntities, stripTags, absolute, slugify, secondsToLabel, titleFromSlug, sanitizeName, ensureDir, shortHash, parseSizeToBytes };
