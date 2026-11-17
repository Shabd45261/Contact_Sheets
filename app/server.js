'use strict';
/* Local runtime: HTTP API + static UI + contact-sheet jobs for the targeted plugins. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const registry = require('./lib/providers');
const { Jobs, resolveStream, isStreamError } = require('./lib/jobs');
const { clip, planSheets } = require('./lib/ffmpeg');
const { buildZip } = require('./lib/zip');
const { sanitizeName, secondsToLabel } = require('./lib/util');

const durationCache = new Map();

const ROOT = registry.ROOT;
const PUBLIC = path.join(__dirname, 'public');
const MEDIA_ROOT = path.join(ROOT, 'extensions');
const CACHE_DIR = path.join(ROOT, 'data', 'cache');
const PORT = Number(process.env.PORT || (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || 7860);

const jobs = new Jobs({ concurrency: 1 });
/* Identity of the running server build: mtime of this file at load time.
   /api/health reports it so a stale page can be told apart from a fresh one. */
const CODE_MTIME = (() => { try { return fs.statSync(__filename).mtime.toISOString(); } catch { return 'unknown'; } })();
/* Newest mtime among server.js + lib/*.js. If later than at boot, files on disk changed
   after this process loaded them (this process runs OLD code in memory). */
function codeStamp() {
  try {
    const lib = path.join(__dirname, 'lib');
    const files = [__filename, ...fs.readdirSync(lib).filter(f => f.endsWith('.js')).map(f => path.join(lib, f))];
    return files.reduce((m, f) => Math.max(m, fs.statSync(f).mtimeMs), 0);
  } catch { return 0; }
}
const BOOT_STAMP = codeStamp();
/* Bump when the job API changes; the page refuses to trust a server below its REQUIRED_API. */
const API_LEVEL = 4;
const FEATURES = ['plan-knobs', 'job-remove', 'window-sheets', 'episode-items', 'youtube-source', 'sheet-captions', 'video-to-pdf', 'provider-subtitles'];
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.mp4': 'video/mp4', '.mkv': 'video/x-matroska',
  '.webm': 'video/webm', '.pdf': 'application/pdf', '.md': 'text/markdown; charset=utf-8',
  '.zip': 'application/zip',
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function text(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 2 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function serveFile(res, file, { cache = 'no-store' } = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': cache,
    });
    fs.createReadStream(file).pipe(res);
  });
}

/* Byte-range aware media serving (AI agents / players expect range support). */
function serveMedia(req, res, file, { cache = 'max-age=3600', disposition } = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const range = req.headers.range;
    const headers = {
      'content-type': type, 'content-length': st.size,
      'accept-ranges': 'bytes', 'cache-control': cache,
    };
    if (disposition) headers['content-disposition'] = `attachment; filename="${disposition.replace(/"/g, '')}"`;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? parseInt(m[2], 10) : st.size - 1;
        if (start >= st.size || end >= st.size || start > end) {
          res.writeHead(416, { 'content-range': `bytes */${st.size}` });
          return res.end();
        }
        res.writeHead(206, {
          'content-type': type, 'content-length': end - start + 1,
          'content-range': `bytes ${start}-${end}/${st.size}`,
          'accept-ranges': 'bytes', 'cache-control': cache,
          ...(disposition ? { 'content-disposition': `attachment; filename="${disposition.replace(/"/g, '')}"` } : {}),
        });
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
    }
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
}

function safeMediaPath(relPath, exts) {
  const clean = decodeURIComponent(relPath).replace(/^\/+/, '');
  const abs = path.resolve(MEDIA_ROOT, clean);
  if (!abs.startsWith(path.resolve(MEDIA_ROOT) + path.sep)) return null;
  if (!exts.test(abs)) return null;
  return abs;
}
const safeSheetPath = relPath => safeMediaPath(relPath, /\.(jpe?g|png|webp|json)$/i);
const safeClipPath = relPath => safeMediaPath(relPath, /\.(mp4|mkv|webm|json)$/i);
const safePdfPath = relPath => safeMediaPath(relPath, /\.(pdf|json)$/i);

const AGENT_MD = `# CloudStream local runtime — agent guide

Base URL: http://127.0.0.1:<PORT> (default 8787, one port per provider launcher).

## 1. Discover providers
GET /api/providers

## 2. Search
GET /api/search?provider=<providerId>&q=<text>
-> { items: [{ id, title, year, type: "movie"|"series", poster, ... }], total }

The youtube provider also accepts in q: a pasted watch / Shorts / youtu.be link,
a bare 11-character video id, or a playlist / channel link (returned as a
series). YouTube serves native content (music videos, trailers, creator
videos, UGC) — never use it to pull a film or series episode.
Its streams carry an extra audioUrl field; clips mux video+audio automatically.
Its clips and sheet sources are fetched through yt-dlp (googlevideo throttles
plain ffmpeg reads); a stream-shaped failure (403 / no data) is retried once
with freshly resolved URLs.

## 3. Detail (seasons, episodes, qualities)
GET /api/detail?provider=<providerId>&id=<id>
-> { detail: { id, title, type, qualities: [1080,720,...],
               seasons: [{ season, name, episodes: [{ number, title }] }] } }

## 4. Streams (direct playable URLs)
GET /api/streams?provider=<providerId>&id=<id>&season=<n>&episode=<n>[&quality=720]

## 5. Clip download (timestamp + duration)
GET  /api/clip?provider=<p>&id=<id>&type=<movie|series>&season=<n>&episode=<n>&start=<sec>&duration=<sec>[&quality=720][&title=<name>][&download=1]
POST /api/clip  (same fields as JSON)
-> video/mp4 bytes (range supported). Files are cached under
   extensions/<repo>/clips/<Provider>/<Title>/<SxxEyy|Movie>/clip_<HHMMSS>_<dur>s.mp4
   with a matching .json sidecar. Pass force=1 to re-cut.
Limits: duration <= 900 s per request.

## 6. Contact sheet (6 columns, timestamped tiles)
POST /api/jobs
{ "provider":"<p>", "id":"<id>", "title":"<name>", "type":"movie|series",
  "season":1, "episodes":[1,2]  // or "items":[{"season":1,"episode":3}]
  "interval": 60               // optional: seconds between snapshots
}
-> { job: { id, ... } }
Poll GET /api/jobs/<jobId> until status is done|failed.
Each sheet is written to extensions/<repo>/contact-sheets/<Provider>/<Title>/<SxxEyy|Movie>/contact-sheet.jpg
and served at /sheets/<repo>/contact-sheets/... ; job.sheets[].url gives the exact link.

Interval rules: without "interval" a sheet uses 30 frames evenly spaced across the full runtime
(6x5). With "interval" a frame is taken every N seconds from 0 (capped by maxFrames, default 120);
the grid is 6 columns and one row per 6 frames.

Sheet plan knobs (any two; the third is derived): "interval" (seconds between frames),
"perSheet" (images per sheet, max 60), "sheets" (number of sheets).

Captions (YouTube only): add "captions": true to burn the video's own YouTube
caption line into every sampled frame. "captionLang" picks the track ("en",
"en-US", ...; default: manual English, else any manual track, else auto English,
else any auto track). job.sheets[].captions reports { lang, source, cues } or an
error; a video without captions still produces a normal sheet.

## 6b. Window sheets (a time period around a fixed timestamp)
Add a "window" object to POST /api/jobs to sample only a slice of the runtime:
{ "provider":"<p>", "id":"<id>", "title":"<name>", "type":"series", "season":1, "episodes":[1],
  "window": { "center": "2:44:30",   // seconds, mm:ss or hh:mm:ss
              "before": 300,          // seconds before center (default 60)
              "after": 55,            // seconds after center  (default 60)
              "interval": 10, "perSheet": 30, "sheets": 1   // own knobs, any two, optional
            } }
The window is clamped to the runtime. Frames are labelled with ABSOLUTE seconds. Output goes to its own folder
<SxxEyy|Movie>-win-<HHMMSS start>-<HHMMSS end>/ so full-runtime sheets are never overwritten.
("start"/"end" may be given instead of center/before/after.)

## 7. Clip jobs (async)
POST /api/clips { provider, id, type, season, episode, start, duration, title }
-> job; poll GET /api/jobs/<id>; job.clips[0].url -> /clips/<repo>/clips/...

## 7b. Video -> PDF (every frame as a page; meant for Shorts)
POST /api/jobs { "provider":"youtube", "id":"<videoId>", "title":"<name>", "type":"movie",
  "kind":"pdf", "fps":30, "width":640 }
-> job; poll GET /api/jobs/<id>; job.pdfs[0].url -> /pdfs/<repo>/pdfs/...
Not restricted to Shorts, but sized for short clips (a 60 s Short at 30 fps is
1,800 pages). The whole video is downloaded through yt-dlp, decoded at "fps" frames per second
(1-30, default 30) and "width" px (160-1280, default 640); each JPEG becomes one
PDF page (DCTDecode passthrough, no re-encode). The downloaded video and the
frame images are deleted once the PDF is written. Frames are capped at 30,000
(~16 min at 30 fps) to protect disk space. Output goes to
extensions/<repo>/pdfs/<Provider>/<Title>/frames-<fps>fps-<width>w.pdf with a
.json sidecar (pages, bytes, duration). The UI card "Video -> PDF" does this.

## 8. Subtitles (moviebox / castletv / youtube)
GET /api/captions?provider=<p>&id=<id>[&season=<n>&episode=<n>]
-> { tracks: [{ lang, label, url?, source, isDefault?, isAI? }] }
   moviebox: both loadCaptions endpoints (get-stream-captions + get-ext-captions),
             per streamId candidate; .srt files on cacdn/pacdn.
   castletv: episodes[].subtitles from the details answer (getVideo2 codes 2/1
             only as fallback); .vtt files. episode defaults to the first one.
   youtube:  manual + auto tracks for the video.
fourkhdhub / vegamovies: no subtitle source (their extractors never emit one).

GET /api/subtitles?provider=<p>&id=<id>&lang=<track lang>&format=srt|vtt
    [&season=<n>&episode=<n>][&name=<download filename>]
-> the subtitle file as a download (converted between SRT and VTT as needed).

## 9. Library
GET /api/library -> { sheets: [...], clips: [...] } (everything already generated)

## 10. Health
GET /api/health
`;

const OPENAPI = {
  openapi: '3.0.3',
  info: { title: 'CloudStream local runtime', version: '1.0.0', description: 'Provider search, streams, clips and contact sheets.' },
  servers: [{ url: 'http://127.0.0.1:8787' }],
  paths: {
    '/api/health': { get: { summary: 'Health', responses: { 200: { description: 'OK' } } } },
    '/api/providers': { get: { summary: 'List providers', responses: { 200: { description: 'Providers' } } } },
    '/api/search': {
      get: {
        summary: 'Search a provider',
        parameters: [
          { name: 'provider', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'Search results' } },
      },
    },
    '/api/detail': {
      get: {
        summary: 'Title detail with seasons/episodes',
        parameters: [
          { name: 'provider', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'id', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'Detail' } },
      },
    },
    '/api/streams': {
      get: {
        summary: 'Resolve playable streams',
        parameters: [
          { name: 'provider', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'id', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'season', in: 'query', schema: { type: 'integer' } },
          { name: 'episode', in: 'query', schema: { type: 'integer' } },
          { name: 'quality', in: 'query', schema: { type: 'integer' } },
        ],
        responses: { 200: { description: 'Streams' } },
      },
    },
    '/api/clip': {
      get: {
        summary: 'Cut a clip (mp4) at a timestamp for a duration',
        parameters: [
          { name: 'provider', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'id', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'type', in: 'query', schema: { type: 'string', enum: ['movie', 'series'] } },
          { name: 'season', in: 'query', schema: { type: 'integer' } },
          { name: 'episode', in: 'query', schema: { type: 'integer' } },
          { name: 'start', in: 'query', required: true, schema: { type: 'number' }, description: 'Start offset in seconds' },
          { name: 'duration', in: 'query', schema: { type: 'number', default: 30, description: 'Seconds (max 900)' } },
          { name: 'quality', in: 'query', schema: { type: 'integer' } },
        ],
        responses: { 200: { description: 'video/mp4' } },
      },
      post: { summary: 'Same as GET, JSON body', responses: { 200: { description: 'video/mp4' } } },
    },
    '/api/jobs': {
      get: { summary: 'List jobs', responses: { 200: { description: 'Jobs' } } },
      post: {
        summary: 'Create a contact-sheet job (optional interval seconds)',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { 201: { description: 'Job created' } },
      },
    },
    '/api/jobs/{id}': {
      get: {
        summary: 'Job status',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Job' } },
      },
    },
    '/api/clips': {
      post: { summary: 'Create an async clip job', responses: { 201: { description: 'Job created' } } },
    },
    '/api/library': { get: { summary: 'List generated sheets and clips', responses: { 200: { description: 'Library' } } } },
  },
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = u.pathname;
  res.setHeader('access-control-allow-origin', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type' });
    return res.end();
  }
  try {
    if (p === '/' || p === '/index.html') return serveFile(res, path.join(PUBLIC, 'index.html'));
    if (p === '/app.js') return serveFile(res, path.join(PUBLIC, 'app.js'));
    if (p === '/styles.css') return serveFile(res, path.join(PUBLIC, 'styles.css'));
    if (p === '/flixworld-movies-profile.jpg')
      return serveFile(res, path.join(PUBLIC, 'flixworld-movies-profile.jpg'));

    if (p.startsWith('/sheets/')) {
      const abs = safeSheetPath(p.slice('/sheets/'.length));
      if (!abs) { res.writeHead(403); return res.end('Forbidden'); }
      /* A versioned link (?v=mtime) can be cached hard; a plain one is re-read
         every time so a rebuilt sheet is never served from the browser cache. */
      return serveFile(res, abs, { cache: u.searchParams.has('v') ? 'max-age=86400' : 'no-store' });
    }
    if (p.startsWith('/clips/')) {
      const abs = safeClipPath(p.slice('/clips/'.length));
      if (!abs) { res.writeHead(403); return res.end('Forbidden'); }
      return serveMedia(req, res, abs, { cache: 'max-age=3600' });
    }
    if (p.startsWith('/pdfs/')) {
      const abs = safePdfPath(p.slice('/pdfs/'.length));
      if (!abs) { res.writeHead(403); return res.end('Forbidden'); }
      return serveMedia(req, res, abs, {
        cache: u.searchParams.has('v') ? 'max-age=86400' : 'no-store',
        disposition: path.basename(abs),
      });
    }

    if (p === '/api/health') {
      return json(res, 200, {
        ok: true, port: PORT, providers: registry.list().length,
        jobs: jobs.list().length, node: process.version, uptime: process.uptime(),
        pid: process.pid,
        startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        build: CODE_MTIME,
        api: API_LEVEL, features: FEATURES,
        stale: codeStamp() > BOOT_STAMP,
      });
    }

    if (p === '/api/providers') {
      const providers = registry.list().map(x => ({
        id: x.id, kind: x.kind, name: x.name, short: x.short, repo: x.repo,
        plugin: x.plugin, file: x.file, language: x.language, region: x.region,
        accent: x.accent, dir: path.relative(ROOT, x.dir).replace(/\\/g, '/'),
        script: path.relative(ROOT, x.script).replace(/\\/g, '/'),
      }));
      const kinds = [...new Set(providers.map(x => x.kind))].map(k => ({
        id: k, label: { moviebox: 'MovieBox', castle: 'CastleTV', fourkhdhub: '4KHDHub', vegamovies: 'VegaMovies', youtube: 'YouTube' }[k] || k,
        providers: providers.filter(x => x.kind === k).map(x => x.id),
      }));
      return json(res, 200, { providers, kinds });
    }

    if (p === '/api/search') {
      const providerId = u.searchParams.get('provider');
      const q = (u.searchParams.get('q') || '').trim();
      if (!providerId) return json(res, 400, { error: 'provider required' });
      if (!q) return json(res, 400, { error: 'q required' });
      const provider = registry.get(providerId);
      const started = Date.now();
      const result = await provider.search(q);
      return json(res, 200, { ...result, provider: providerId, query: q, ms: Date.now() - started });
    }

    if (p === '/api/detail') {
      const providerId = u.searchParams.get('provider');
      const id = u.searchParams.get('id');
      if (!providerId || !id) return json(res, 400, { error: 'provider and id required' });
      const provider = registry.get(providerId);
      const doc = typeof provider.fullDetail === 'function'
        ? await provider.fullDetail(id)
        : await provider.detail(id);
      return json(res, 200, { provider: providerId, detail: doc });
    }

    if (p === '/api/streams') {
      const providerId = u.searchParams.get('provider');
      const id = u.searchParams.get('id');
      if (!providerId || !id) return json(res, 400, { error: 'provider and id required' });
      const provider = registry.get(providerId);
      const streams = await provider.streams({
        id,
        season: Number(u.searchParams.get('season') || 1),
        episode: Number(u.searchParams.get('episode') || 0),
        quality: u.searchParams.get('quality') ? Number(u.searchParams.get('quality')) : undefined,
      });
      return json(res, 200, { provider: providerId, streams });
    }

    if (p === '/api/index-status') {
      const providerId = u.searchParams.get('provider');
      const provider = registry.get(providerId);
      if (typeof provider.indexStatus !== 'function') return json(res, 400, { error: 'provider has no sitemap index' });
      return json(res, 200, await provider.indexStatus());
    }

    /* Runtime duration of one episode/movie (probe once, cached). */
    if (p === '/api/duration') {
      const providerId = u.searchParams.get('provider');
      const id = u.searchParams.get('id');
      if (!providerId || !id) return json(res, 400, { error: 'provider and id required' });
      const season = Number(u.searchParams.get('season') || 0);
      const episode = Number(u.searchParams.get('episode') || 0);
      const key = `${providerId}|${id}|${season}|${episode}`;
      const hit = durationCache.get(key);
      if (hit && Date.now() - hit.at < 10 * 60 * 1000) return json(res, 200, { ...hit.value, cached: true });
      const provider = registry.get(providerId);
      const { stream, probe: pr } = await resolveStream(provider, { id_: id, quality: u.searchParams.get('quality') || null }, season, episode);
      const value = {
        duration: Number(pr.duration.toFixed(1)),
        durationLabel: secondsToLabel(pr.duration),
        quality: stream.quality || 0, format: stream.format || '',
      };
      durationCache.set(key, { at: Date.now(), value });
      return json(res, 200, value);
    }

    /* Sheet plan preview: any two of interval / perSheet / sheets -> the third. */
    if (p === '/api/plan') {
      const duration = Number(u.searchParams.get('duration') || 0);
      if (!duration) return json(res, 400, { error: 'duration required' });
      const plan = planSheets(duration, {
        interval: Number(u.searchParams.get('interval') || 0),
        perSheet: Number(u.searchParams.get('perSheet') || 0),
        sheets: Number(u.searchParams.get('sheets') || 0),
      });
      return json(res, 200, {
        duration: Number(duration.toFixed(1)),
        interval: plan.interval, perSheet: plan.perSheet, sheets: plan.sheets,
        totalFrames: plan.totalFrames,
        panels: plan.panels.map((x, i) => ({ index: i + 1, frames: x.times.length, rows: x.rows, first: x.times[0], last: x.times[x.times.length - 1] })),
      });
    }

    if (p === '/api/jobs' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.provider || !body.id) return json(res, 400, { error: 'provider and id required' });
      if (body.kind === 'clip') {
        if (body.start == null && body.timestamp != null) body.start = body.timestamp;
        if (body.duration == null) body.duration = 30;
      } else if ((!body.episodes || !body.episodes.length) && !(Array.isArray(body.items) && body.items.length)) {
        // movies may omit episodes (jobs.create defaults to the whole movie)
        if (body.type === 'series') return json(res, 400, { error: 'episodes or items required for a series' });
      }
      const job = jobs.create(body);
      return json(res, 201, { job });
    }
    if (p === '/api/clips' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.provider || !body.id) return json(res, 400, { error: 'provider and id required' });
      const job = jobs.create({
        ...body, kind: 'clip',
        start: body.start != null ? body.start : body.timestamp,
        duration: body.duration,
        items: body.items || [{ season: Number(body.season) || 0, episode: Number(body.episode) || 0 }],
      });
      return json(res, 201, { job });
    }

    /* One-shot clip download for agents: GET/POST /api/clip -> mp4 bytes. */
    if (p === '/api/clip' && (req.method === 'GET' || req.method === 'POST')) {
      const params = req.method === 'POST' ? await readBody(req) : Object.fromEntries(u.searchParams.entries());
      const providerId = params.provider;
      const id = params.id;
      if (!providerId || !id) return json(res, 400, { error: 'provider and id required' });
      const provider = registry.get(providerId);
      const type = params.type === 'series' ? 'series' : 'movie';
      const season = Number(params.season) || (type === 'series' ? 1 : 0);
      const episode = Number(params.episode || params.ep) || 0;
      const start = Math.max(0, Number(params.start != null ? params.start : params.timestamp) || 0);
      const duration = Math.min(900, Math.max(0.5, Number(params.duration) || 30));
      const quality = params.quality ? Number(params.quality) : undefined;
      const title = sanitizeName(params.title || 'Untitled', 120);
      const stamp = (sec) => {
        const s = Math.max(0, Math.round(sec));
        return `${String(Math.floor(s / 3600)).padStart(2, '0')}${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}${String(s % 60).padStart(2, '0')}`;
      };
      const folder = type === 'series' ? `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}` : 'Movie';
      const outDir = path.join(MEDIA_ROOT, registry.list().find(x => x.id === providerId).repo, 'clips',
        sanitizeName(registry.list().find(x => x.id === providerId).short), title, folder);
      const outFile = path.join(outDir, `clip_${stamp(start)}_${Math.round(duration)}s.mp4`);
      if (params.force !== '1' && fs.existsSync(outFile) && fs.statSync(outFile).size > 2048) {
        res.setHeader('x-clip-cached', '1');
        return serveMedia(req, res, outFile, { cache: 'max-age=60' });
      }
      let stream = null, pr = null, result = null;
      let realStart = start, realDuration = duration;
      /* Two passes: the cut can fail on a rate-limited / expired stream URL
         even after probing fine — re-resolve fresh URLs once and cut again. */
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          ({ stream, probe: pr } = await resolveStream(provider, {
            id_: id, quality,
          }, season, episode));
          realStart = Math.min(start, Math.max(0, pr.duration - 1));
          realDuration = Math.min(duration, Math.max(0.5, pr.duration - realStart));
          result = typeof provider.fetchClip === 'function'
            ? await provider.fetchClip({
              id, episode, quality,
              start: realStart, duration: realDuration, out: outFile,
            })
            : await clip({
              input: stream.url, headers: stream.headers,
              audioInput: stream.audioUrl, audioHeaders: stream.audioHeaders,
              out: outFile,
              start: realStart, duration: realDuration,
            });
          break;
        } catch (e) {
          if (!isStreamError(e) || attempt === 2) throw e;
          if (typeof provider.invalidate === 'function') provider.invalidate(id);
        }
      }
      if (!result) throw new Error('clip produced no data');
      fs.writeFileSync(outFile.replace(/\.mp4$/, '.json'), JSON.stringify({
        provider: providerId, title, type, season, episode, folder,
        sourceDuration: Number(pr.duration.toFixed(1)),
        start: Number(realStart.toFixed(2)), duration: Number(realDuration.toFixed(2)),
        bytes: result.bytes, cutMode: result.mode,
        stream: { url: stream.url.slice(0, 400), quality: stream.quality || 0, audio: !!stream.audioUrl },
        generatedAt: new Date().toISOString(),
      }, null, 2));
      res.setHeader('x-clip-provider', providerId);
      res.setHeader('x-clip-quality', String(stream.quality || 0));
      res.setHeader('x-clip-start', String(realStart));
      if (params.download === '1') {
        res.setHeader('content-disposition', `attachment; filename="${path.basename(outFile)}"`);
      }
      return serveMedia(req, res, outFile, { cache: 'max-age=60' });
    }

    /* Machine-readable guide for AI agents. */
    if (p === '/api/agent.md') {
      return text(res, 200, AGENT_MD, 'text/markdown; charset=utf-8');
    }
    if (p === '/api/openapi.json') {
      return json(res, 200, OPENAPI);
    }

    /* Library index: everything generated so far (sheets + clips). */
    if (p === '/api/library') {
      const out = { sheets: [], clips: [] };
      const repos = fs.existsSync(MEDIA_ROOT) ? fs.readdirSync(MEDIA_ROOT, { withFileTypes: true }).filter(d => d.isDirectory()) : [];
      for (const repo of repos) {
        for (const [sub, key, ext] of [['contact-sheets', 'sheets', /contact-sheet\.jpg$/i], ['clips', 'clips', /\.mp4$/i]]) {
          const base = path.join(MEDIA_ROOT, repo.name, sub);
          if (!fs.existsSync(base)) continue;
          for (const providerDir of fs.readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory())) {
            const provBase = path.join(base, providerDir.name);
            for (const titleDir of fs.readdirSync(provBase, { withFileTypes: true }).filter(d => d.isDirectory())) {
              const titleBase = path.join(provBase, titleDir.name);
              for (const epDir of fs.readdirSync(titleBase, { withFileTypes: true }).filter(d => d.isDirectory())) {
                const epBase = path.join(titleBase, epDir.name);
                for (const f of fs.readdirSync(epBase)) {
                  if (!ext.test(f)) continue;
                  const abs = path.join(epBase, f);
                  out[key].push({
                    repo: repo.name, provider: providerDir.name, title: titleDir.name,
                    episode: epDir.name, file: f,
                    bytes: fs.statSync(abs).size,
                    url: (key === 'sheets' ? '/sheets/' : '/clips/') + path.relative(MEDIA_ROOT, abs).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/'),
                  });
                }
              }
            }
          }
        }
      }
      return json(res, 200, out);
    }

    if (p === '/api/jobs' && req.method === 'GET') {
      return json(res, 200, { jobs: jobs.list() });
    }
    const jobMatch = p.match(/^\/api\/jobs\/([a-z0-9_]+)(\/cancel|\/remove|\/zip)?$/i);
    if (jobMatch) {
      if (jobMatch[2] === '/zip') {
        if (req.method !== 'GET') return json(res, 405, { error: 'GET required' });
        const j = jobs.get(jobMatch[1]);
        if (!j) return json(res, 404, { error: 'job not found' });
        const sheets = (j.sheets || []).filter(s => s.path);
        if (!sheets.length) return json(res, 400, { error: 'this job has no contact sheets' });
        const zipPath = path.join(CACHE_DIR, `zip-${jobMatch[1]}.zip`);
        // Rebuild only when the zip is missing or older than any sheet file.
        let rebuild = true;
        try {
          const zst = fs.statSync(zipPath);
          const newestSheet = sheets.reduce((m, s) => {
            try { return Math.max(m, fs.statSync(path.resolve(ROOT, s.path)).mtimeMs); } catch { return m; }
          }, 0);
          if (zst.isFile() && zst.mtimeMs >= newestSheet) rebuild = false;
        } catch { rebuild = true; }
        if (rebuild) {
          try {
            await buildZip({
              files: sheets.map(s => path.resolve(ROOT, s.path)),
              out: zipPath,
              base: MEDIA_ROOT,
            });
          } catch (e) {
            return json(res, 500, { error: 'could not build zip: ' + (e.message || e) });
          }
        }
        const name = (j.title || 'contact-sheets').replace(/[^\w.\- ]+/g, '_').trim() + '.zip';
        return serveMedia(req, res, zipPath, { cache: 'no-store', disposition: name });
      }
      if (jobMatch[2]) {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST required' });
        if (jobMatch[2] === '/remove') {
          const j = jobs.remove(jobMatch[1], {
            deleteFiles: (u.searchParams.get('files') || '1') !== '0',
          });
          return j ? json(res, 200, { job: j }) : json(res, 404, { error: 'job not found' });
        }
        const j = jobs.cancel(jobMatch[1]);
        return j ? json(res, 200, { job: j }) : json(res, 404, { error: 'job not found' });
      }
      if (req.method === 'DELETE') {
        const j = jobs.remove(jobMatch[1]);
        return j ? json(res, 200, { job: j }) : json(res, 404, { error: 'job not found' });
      }
      if (req.method !== 'GET') return json(res, 405, { error: 'GET required' });
      const j = jobs.get(jobMatch[1]);
      return j ? json(res, 200, { job: j }) : json(res, 404, { error: 'job not found' });
    }

    if (p === '/api/captions' && req.method === 'GET') {
      const providerId = u.searchParams.get('provider') || '';
      const provider = registry.get(providerId);
      if (!provider) return json(res, 400, { error: 'unknown provider' });
      if (typeof provider.listCaptions !== 'function') {
        return json(res, 400, { error: 'captions are not supported for this provider' });
      }
      try {
        const id = u.searchParams.get('id') || '';
        const season = Number(u.searchParams.get('season') || 0);
        const episode = Number(u.searchParams.get('episode') || 0);
        const out = await provider.listCaptions({ id, episode, season });
        return json(res, 200, out);
      } catch (e) {
        return json(res, 500, { error: e.message || String(e) });
      }
    }

    if (p === '/api/subtitles' && req.method === 'GET') {
      const providerId = u.searchParams.get('provider') || '';
      const provider = registry.get(providerId);
      if (!provider) return json(res, 400, { error: 'unknown provider' });
      if (typeof provider.fetchCaptions !== 'function') {
        return json(res, 400, { error: 'subtitles are not supported for this provider' });
      }
      try {
        const id = u.searchParams.get('id') || '';
        const season = Number(u.searchParams.get('season') || 0);
        const episode = Number(u.searchParams.get('episode') || 0);
        const lang = u.searchParams.get('lang') || '';
        const format = (u.searchParams.get('format') || 'srt').toLowerCase();
        const fmt = format === 'vtt' ? 'vtt' : 'srt';
        const mime = fmt === 'vtt' ? 'text/vtt; charset=utf-8' : 'application/x-subrip; charset=utf-8';
        const out = path.join(CACHE_DIR, `subtitle-${providerId}-${Date.now()}.${fmt}`);
        const capRes = await provider.fetchCaptions({ id, episode, season, lang, out, format: fmt });
        const abs = capRes.file;
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        // serve the downloaded file
        const st = fs.statSync(abs);
        const dlName = sanitizeName(u.searchParams.get('name') || '', 90);
        const fname = (dlName && `${dlName}.${fmt}`) || capRes.name || path.basename(abs);
        res.writeHead(200, {
          'content-type': mime,
          'content-length': st.size,
          'content-disposition': `attachment; filename="${fname}"`,
          'cache-control': 'no-store',
        });
        fs.createReadStream(abs).pipe(res);
        // cleanup after a delay
        setTimeout(() => { try { fs.rmSync(abs, { force: true }); } catch {} }, 60000);
        return;
      } catch (e) {
        return json(res, 500, { error: e.message || String(e) });
      }
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (e) {
    json(res, 500, { error: e.message || String(e) });
  }
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use. Close the other window or set PORT=<port>.\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log('\n  CloudStream local runtime');
  console.log('  ' + url);
  console.log(`  providers: ${registry.list().length}  |  contact sheets: extensions/<repo>/contact-sheets/`);
  console.log('  Press Ctrl+C to stop.\n');
  if (process.env.OPEN_BROWSER === '1') {
    const { spawn } = require('child_process');
    const target = process.env.OPEN_URL || url;
    try { spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore' }).unref(); } catch {}
  }
});

module.exports = { server, jobs };
