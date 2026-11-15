'use strict';
/* Job queue: contact sheets (whole title / episodes) and clip cuts.
   sheet job: resolve stream -> probe -> sample frames -> tile -> index.json
   clip job:  resolve stream -> probe -> ffmpeg cut -> mp4 + index.json */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const registry = require('./providers');
const { contactSheetSmart, clip, probe, planSheets, COUNT, COLS, ROWS, extractFrames } = require('./ffmpeg');
const { ensureDir, sanitizeName, secondsToLabel } = require('./util');
const { parseSrt } = require('./captions');
const { buildPdf } = require('./pdf');

const ROOT = registry.ROOT;
const CACHE_DIR = path.join(ROOT, 'data', 'cache');

function rel(p) { return path.relative(ROOT, p).replace(/\\/g, '/'); }
function repoRel(p) { return path.relative(path.join(ROOT, 'extensions'), p).replace(/\\/g, '/'); }
/* Percent-encode each path segment so titles containing spaces, '#', '?', '%'
   or other URL-special characters survive the round trip through the browser. */
function encodePath(p) {
  return String(p).split('/').map(seg => encodeURIComponent(seg)).join('/');
}
/* Generated files keep a deterministic path (a sheet rebuilt with captions lands
   on the same contact-sheet.jpg), so the mtime rides on the query string. Without
   it the browser kept showing the previous, caption-less JPEG from its cache. */
function versionedUrl(prefix, absPath) {
  let v = Date.now();
  try { v = Math.round(fs.statSync(absPath).mtimeMs); } catch { /* file vanished */ }
  return `${prefix}${encodePath(repoRel(absPath))}?v=${v}`;
}
function epFolder(season, episode, type) {
  if (type !== 'series') return 'Movie';
  return `S${String(season || 1).padStart(2, '0')}E${String(episode || 0).padStart(2, '0')}`;
}
function stamp(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return `${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}${String(r).padStart(2, '0')}`;
}

/* "2:44:30" | "164:30" | 9870 | "9870.5" -> seconds (fallback when blank/invalid). */
function parseClock(v, fb = NaN) {
  if (v == null || v === '') return fb;
  if (typeof v === 'number') return Number.isFinite(v) ? v : fb;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(':').map(Number);
  if (!parts.length || parts.length > 3 || parts.some(n => !Number.isFinite(n))) return fb;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/* Window spec: a time period around a fixed timestamp, with its own plan knobs.
   { center, before, after } or { start, end }; interval/perSheet/sheets optional. */
function parseWindow(spec) {
  const w = spec && spec.window;
  if (!w || typeof w !== 'object') return null;
  const center = parseClock(w.center ?? w.timestamp ?? w.around);
  const startIn = parseClock(w.start);
  const endIn = parseClock(w.end);
  if (!Number.isFinite(center) && !(Number.isFinite(startIn) && Number.isFinite(endIn))) {
    throw new Error('window needs a center timestamp (or start and end)');
  }
  const before = Math.max(0, parseClock(w.before, 60));
  const after = Math.max(0, parseClock(w.after, 60));
  const iv = Number(w.interval);
  const per = Number(w.perSheet ?? w.imagesPerSheet);
  const sh = Number(w.sheets ?? w.sheetCount);
  return {
    center: Number.isFinite(center) ? center : null,
    before, after,
    start: Number.isFinite(startIn) ? startIn : null,
    end: Number.isFinite(endIn) ? endIn : null,
    interval: iv > 0 ? iv : 0,
    perSheet: per > 0 ? Math.max(1, Math.min(60, Math.round(per))) : 0,
    sheets: sh > 0 ? Math.max(1, Math.round(sh)) : 0,
  };
}

/* Errors that mean the stream URL went bad (expired, 403, reset) rather than a
   code bug — worth one retry with freshly resolved URLs. */
function isStreamError(e) {
  return /403|429|forbidden|no data|produced no data|timed out|expired|invalid|ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|yt-dlp exited|Could not (probe|open|read|get|seek)/i
    .test(String((e && e.message) || ''));
}

/* Pick the first stream that ffprobe can read; prefer a working copy over order.
   On a stream-shaped failure, drop the provider's URL cache once and re-resolve
   (googlevideo URLs are IP-signed and rate-limit under repeated use). */
async function resolveStream(provider, job, season, ep) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt && typeof provider.invalidate === 'function') {
      provider.invalidate(job.id_);
    }
    try {
      return await _resolveStreamOnce(provider, job, season, ep);
    } catch (e) {
      lastErr = e;
      if (attempt || !isStreamError(e)) throw e;
    }
  }
  throw lastErr;
}

async function _resolveStreamOnce(provider, job, season, ep) {
  const streams = await provider.streams({
    id: job.id_, season, episode: ep, quality: job.quality,
  });
  if (!streams || !streams.length) throw new Error('No playable stream returned');
  const tried = [];
  for (const c of streams) {
    try {
      const p = await probe(c.url, { headers: c.headers });
      if (c.expected >= 600 && p.duration > 0 && p.duration < 45) {
        tried.push(`${c.quality || '?'}p: ${Math.round(p.duration)}s notice clip (client version outdated?)`);
        continue;
      }
      if (p.duration && isFinite(p.duration) && p.duration > 0) {
        return { stream: c, probe: p };
      }
      tried.push(`${c.quality || '?'}p: no duration`);
    } catch (e) {
      tried.push(`${c.quality || '?'}p: ${e.message.slice(0, 90)}`);
    }
  }
  throw new Error('Could not probe any stream (' + tried.slice(0, 3).join(' | ') + ')');
}

class Jobs extends EventEmitter {
  constructor({ concurrency = 1 } = {}) {
    super();
    this.map = new Map();
    this.queue = [];
    this.active = 0;
    this.concurrency = concurrency;
  }

  list() {
    return [...this.map.values()].sort((a, b) => b.createdAt - a.createdAt)
      .map(j => this._public(j));
  }

  get(id) { const j = this.map.get(id); return j ? this._public(j) : null; }

  create(spec) {
    const entry = registry.list().find(p => p.id === spec.provider);
    if (!entry) throw new Error('Unknown provider: ' + spec.provider);
    const kind = spec.kind === 'clip' ? 'clip' : spec.kind === 'pdf' ? 'pdf' : 'sheet';
    const type = spec.type === 'series' ? 'series' : 'movie';
    let episodes = Array.isArray(spec.episodes) ? spec.episodes.map(Number).filter(n => Number.isFinite(n)) : [];
    if (!episodes.length && !Array.isArray(spec.items)) episodes = [0];
    const items = Array.isArray(spec.items) && spec.items.length
      ? spec.items.map(x => ({ season: Number(x.season) || 0, episode: Number(x.episode) || 0 }))
      : episodes.map(e => ({ season: Number(spec.season) || (type === 'series' ? 1 : 0), episode: e }));
    if (kind === 'clip' || kind === 'pdf') items.length = Math.min(items.length, 1);
    const clipSpec = kind === 'clip' ? {
      start: Math.max(0, Number(spec.start) || 0),
      duration: Math.max(0.5, Number(spec.duration) || 30),
      label: spec.label ? sanitizeName(spec.label, 60) : '',
    } : null;
    const interval = Number(spec.interval) > 0 ? Number(spec.interval) : 0;
    const perSheet = Number(spec.perSheet ?? spec.imagesPerSheet) > 0
      ? Math.max(1, Math.min(60, Math.round(Number(spec.perSheet ?? spec.imagesPerSheet)))) : 0;
    const wantSheets = Number(spec.sheets ?? spec.sheetCount) > 0
      ? Math.max(1, Math.round(Number(spec.sheets ?? spec.sheetCount))) : 0;
    const win = kind === 'clip' ? null : parseWindow(spec);
    /* Burn YouTube's own captions into the sampled frames — sheet jobs only,
       and only when the provider can actually fetch them. */
    let canCaption = false;
    try { canCaption = typeof registry.get(entry.id).fetchCaptions === 'function'; } catch { /* no provider */ }
    const captions = kind === 'sheet' && spec.captions === true && canCaption;
    const captionLang = captions && spec.captionLang ? String(spec.captionLang).trim().slice(0, 12) : '';
    /* Video -> PDF: one whole video, decoded at a fixed fps and width. */
    const fps = kind === 'pdf' ? Math.max(1, Math.min(30, Math.round(Number(spec.fps) || 30))) : 0;
    const frameWidth = kind === 'pdf' ? Math.max(160, Math.min(1280, Math.round(Number(spec.width) || 640))) : 0;
    const job = {
      id: 'job_' + crypto.randomBytes(6).toString('hex'),
      createdAt: Date.now(), startedAt: 0, finishedAt: 0, kind,
      status: 'queued', progress: 0, phase: 'queued', message: 'Waiting in queue',
      provider: entry.id, providerName: entry.short, repo: entry.repo,
      title: sanitizeName(spec.title || 'Untitled', 120),
      id_: spec.id, type, season: Number(spec.season || (type === 'series' ? 1 : 0)),
      items, episodes: items.map(x => x.episode), quality: spec.quality || null,
      mode: win ? 'window' : (spec.mode || (kind === 'clip' ? 'clip' : 'custom')),
      interval: win ? win.interval : interval, perSheet: win ? win.perSheet : perSheet,
      wantSheets: win ? win.sheets : wantSheets, plan: null, window: win, dirs: [],
      maxFrames: Number(spec.maxFrames) > 0 ? Number(spec.maxFrames) : 120,
      clip: clipSpec,
      captions, captionLang, captionsInfo: null,
      fps, frameWidth, pdfs: [],
      sheets: [], clips: [], errors: [], log: [],
      cancelRequested: false,
    };
    this.map.set(job.id, job);
    this.queue.push(job);
    const knobs = [interval ? `interval ${interval}s` : '', perSheet ? `${perSheet}/sheet` : '',
      wantSheets ? `${wantSheets} sheets` : ''].filter(Boolean).join(', ');
    this._log(job, kind === 'clip'
      ? `Queued clip ${stamp(clipSpec.start)} +${clipSpec.duration}s for ${job.title}`
      : `Queued ${items.length} episode(s) for ${job.title}${knobs ? ` (${knobs})` : ''}`);
    if (captions) this._log(job, `Captions: ${captionLang || 'auto'} (YouTube track)`);
    if (kind === 'pdf') this._log(job, `PDF: every frame at ${fps} fps, ${frameWidth}px wide`);
    this._pump();
    return this._public(job);
  }

  cancel(id) {
    const j = this.map.get(id);
    if (!j) return null;
    if (j.status === 'queued') {
      j.status = 'cancelled'; j.phase = 'cancelled'; j.finishedAt = Date.now();
      this.queue = this.queue.filter(x => x !== j);
    } else if (j.status === 'running') {
      j.cancelRequested = true;
      this._log(j, 'Cancel requested');
    }
    return this._public(j);
  }

  /* Remove a job from the panel. Finished jobs also have their generated
     files deleted; running jobs are only cancelled (files may be incomplete). */
  remove(id, { deleteFiles = true } = {}) {
    const j = this.map.get(id);
    if (!j) return null;
    const wasRunning = j.status === 'running' || j.status === 'queued';
    if (wasRunning) {
      if (j.status === 'running') j.cancelRequested = true;
      j.status = 'cancelled'; j.phase = 'cancelled';
      j.finishedAt = j.finishedAt || Date.now();
      j.message = 'Cancelled';
    }
    this.map.delete(id);
    this.queue = this.queue.filter(x => x !== j);
    let removedFiles = 0;
    if (deleteFiles && !wasRunning) {
      try { removedFiles = this._deleteJobFiles(j); } catch { /* best effort */ }
    }
    return { ...this._public(j), removed: true, removedFiles };
  }

  /* Delete what this job wrote. Clip files have unique timestamped names, so
     they are removed individually (other jobs' clips in the same folder stay).
     Sheet jobs own their episode folder, so the folder is removed wholesale. */
  _deleteJobFiles(j) {
    const sub = j.kind === 'clip' ? 'clips' : j.kind === 'pdf' ? 'pdfs' : 'contact-sheets';
    const titleRoot = path.join(ROOT, 'extensions', j.repo, sub,
      sanitizeName(j.providerName), j.title);
    let deleted = 0;

    if (j.kind === 'pdf') {
      const files = [...new Set((j.pdfs || []).map(p =>
        path.join(ROOT, String(p.path || '').replace(/\//g, path.sep))))];
      for (const f of files) {
        if (!f.startsWith(titleRoot) || !fs.existsSync(f)) continue;
        fs.rmSync(f, { force: true });
        const sidecar = f.replace(/\.pdf$/i, '.json');
        if (fs.existsSync(sidecar)) fs.rmSync(sidecar, { force: true });
        deleted++;
      }
      for (const dir of [titleRoot, path.dirname(titleRoot)]) {
        try {
          if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmSync(dir, { recursive: true, force: true });
        } catch { /* ignore */ }
      }
      return deleted;
    }

    if (j.kind === 'clip') {
      const files = [...new Set((j.clips || []).map(c => path.join(ROOT, String(c.path || '').replace(/\//g, path.sep))))];
      for (const f of files) {
        if (!f.startsWith(titleRoot) || !fs.existsSync(f)) continue;
        fs.rmSync(f, { force: true });
        const sidecar = f.replace(/\.mp4$/i, '.json');
        if (fs.existsSync(sidecar)) fs.rmSync(sidecar, { force: true });
        deleted++;
      }
      // Drop directories that became empty: episode -> title -> provider.
      const eps = [...new Set((j.items || []).map(it =>
        path.join(titleRoot, epFolder(it.season, it.episode, j.type))))];
      for (const dir of [...eps.map(d => path.dirname(d)), ...eps, titleRoot, path.dirname(titleRoot)]) {
        try {
          if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmSync(dir, { recursive: true, force: true });
        } catch { /* ignore */ }
      }
      return deleted;
    }

    // Window jobs write to their own folders (recorded in j.dirs); never touch the plain episode folder.
    const folders = j.window
      ? [...new Set((j.dirs || []).map(d => path.join(titleRoot, d)))]
      : [...new Set((j.items || []).map(it =>
        path.join(titleRoot, epFolder(it.season, it.episode, j.type))))];
    const deletedNames = new Set();
    for (const f of folders) {
      if (!fs.existsSync(f)) continue;
      fs.rmSync(f, { recursive: true, force: true });
      deletedNames.add(path.basename(f));
      deleted++;
    }
    if (!deleted) return 0;
    if (fs.existsSync(path.join(titleRoot, 'index.json'))) {
      try {
        const file = path.join(titleRoot, 'index.json');
        const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
        const keep = (prev.sheets || []).filter(s => !deletedNames.has(String(s.label || '').split(' #')[0]));
        if (keep.length !== (prev.sheets || []).length) {
          fs.writeFileSync(file, JSON.stringify({ ...prev, sheets: keep }, null, 2));
        }
      } catch { /* index rewrite is best-effort */ }
    }
    // Drop the title folder and provider folder when they are now empty.
    for (const dir of [titleRoot, path.dirname(titleRoot)]) {
      try {
        if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmSync(dir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
    return deleted;
  }

  _public(j) {
    return {
      id: j.id, kind: j.kind, status: j.status, progress: Math.round(j.progress),
      phase: j.phase, message: j.message, provider: j.provider, providerName: j.providerName,
      repo: j.repo, title: j.title, type: j.type, season: j.season, episodes: j.episodes, items: j.items,
      quality: j.quality, mode: j.mode, interval: j.interval, perSheet: j.perSheet,
      wantSheets: j.wantSheets, plan: j.plan, clip: j.clip, window: j.window,
      captions: j.captions, captionLang: j.captionLang, captionsInfo: j.captionsInfo,
      fps: j.fps, frameWidth: j.frameWidth, pdfs: j.pdfs,
      sheets: j.sheets, clips: j.clips, errors: j.errors,
      createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt,
      log: j.log.slice(-40),
    };
  }

  _log(j, msg) {
    j.log.push({ at: Date.now(), msg });
    if (j.log.length > 200) j.log.shift();
    this.emit('update', this._public(j));
  }

  _set(j, patch) { Object.assign(j, patch); this.emit('update', this._public(j)); }

  async _pump() {
    while (this.active < this.concurrency) {
      const job = this.queue.shift();
      if (!job) return;
      this.active++;
      this._run(job).finally(() => { this.active--; this._pump(); });
    }
  }

  async _run(job) {
    job.status = 'running'; job.startedAt = Date.now();
    this._set(job, { status: 'running', phase: 'starting', message: 'Starting', progress: 1 });
    if (job.kind === 'clip') return this._runClip(job);
    if (job.kind === 'pdf') return this._runPdf(job);

    const provider = registry.get(job.provider);
    const sheetRoot = path.join(ROOT, 'extensions', job.repo, 'contact-sheets',
      sanitizeName(job.providerName), job.title);
    ensureDir(sheetRoot);
    const total = job.items.length;

    for (let i = 0; i < job.items.length; i++) {
      if (job.cancelRequested) break;
      const { season, episode: ep } = job.items[i];
      const base = (i / total) * 100;
      const span = 100 / total;
      let folder = epFolder(season, ep, job.type);
      let outDir = path.join(sheetRoot, folder);
      if (!job.window) { ensureDir(outDir); job.dirs.push(folder); }
      let shortName = job.type === 'series' ? folder : 'Movie';
      try {
        this._set(job, {
          phase: 'resolving', message: `Resolving stream for ${shortName}`,
          progress: Math.round(base + span * 0.05),
        });
        const { stream: chosen, probe: pr } = await resolveStream(provider, job, season, ep);
        if (job.cancelRequested) break;
        /* Providers whose media reads slowly over HTTP (YouTube: googlevideo
           throttles ffmpeg) can hand over a local copy first; every panel is
           then sampled from disk. Removed again in the finally below. */
        let localMedia = null;
        if (typeof provider.fetchFile === 'function') {
          this._set(job, {
            phase: 'fetching',
            message: `Fetching ${shortName} source`,
            progress: Math.round(base + span * 0.1),
          });
          localMedia = await provider.fetchFile({
            id: job.id_, episode: ep, quality: job.quality,
            out: path.join(CACHE_DIR, `media-${job.id}-${season}-${ep}.mp4`),
          });
        }
        this._set(job, {
          phase: 'sampling', message: `Sampling contact sheet from ${shortName}`,
          progress: Math.round(base + span * 0.15),
        });
        this._set(job, {
          phase: 'planning',
          message: `Planning sheets for ${shortName}`,
          progress: Math.round(base + span * 0.13),
        });
        const knobs = { interval: job.interval, perSheet: job.perSheet, sheets: job.wantSheets };
        let plan;
        let wInfo = null;
        if (job.window) {
          // Sample only [ws, we]: plan over the window length, then shift to absolute time.
          const w = job.window;
          let ws = w.start != null ? w.start : (w.center - w.before);
          let we = w.end != null ? w.end : (w.center + w.after);
          ws = Math.max(0, ws);
          we = Math.min(pr.duration - 0.5, we);
          if (we - ws < 1) {
            throw new Error(`window ${secondsToLabel(ws)}-${secondsToLabel(we)} is outside the runtime (${secondsToLabel(pr.duration)})`);
          }
          plan = planSheets(we - ws, knobs);
          for (const pn of plan.panels) pn.times = pn.times.map(t => Number((t + ws).toFixed(3)));
          wInfo = {
            center: w.center, before: w.before, after: w.after,
            start: Number(ws.toFixed(1)), end: Number(we.toFixed(1)),
            startLabel: secondsToLabel(ws), endLabel: secondsToLabel(we),
            length: Number((we - ws).toFixed(1)),
          };
          folder = `${epFolder(season, ep, job.type)}-win-${stamp(ws)}-${stamp(we)}`;
          outDir = path.join(sheetRoot, folder);
          ensureDir(outDir);
          if (!job.dirs.includes(folder)) job.dirs.push(folder);
          shortName = folder;
        } else {
          plan = planSheets(pr.duration, knobs);
        }
        this._set(job, {
          plan: {
            interval: plan.interval, perSheet: plan.perSheet,
            sheets: plan.sheets, totalFrames: plan.totalFrames,
            duration: Number(pr.duration.toFixed(1)),
            window: wInfo,
          },
        });
        this._log(job, `${shortName}: ${plan.sheets} sheet(s) × ${plan.perSheet} frames every ${plan.interval}s`);
        const panels = [];
        let captionCues = null;
        let capInfo = null;
        try {
          if (job.captions) {
            this._set(job, {
              phase: 'captions',
              message: `Fetching captions for ${shortName}`,
              progress: Math.round(base + span * 0.13),
            });
            try {
              const cap = await provider.fetchCaptions({
                id: job.id_, episode: ep, lang: job.captionLang,
                out: path.join(CACHE_DIR, `captions-${job.id}-${season}-${ep}`),
              });
              captionCues = parseSrt(fs.readFileSync(cap.file, 'utf8'));
              capInfo = { episode: ep, lang: cap.lang, source: cap.source, cues: captionCues.length };
              if (!captionCues.length) {
                captionCues = null;
                capInfo.error = 'caption track was empty';
                this._log(job, `${shortName}: captions found but no readable cues — sheet without captions`);
              } else {
                this._log(job, `${shortName}: ${captionCues.length} caption cues (${cap.lang}, ${cap.source})`);
              }
            } catch (e) {
              capInfo = { episode: ep, error: e.message };
              this._log(job, `${shortName}: captions skipped — ${e.message}`);
            }
            job.captionsInfo = capInfo;
          }
          for (let p = 0; p < plan.panels.length; p++) {
            if (job.cancelRequested) break;
            const panel = plan.panels[p];
            const fileName = plan.panels.length === 1
              ? 'contact-sheet.jpg'
              : `contact-sheet-${String(p + 1).padStart(2, '0')}.jpg`;
            const sheetPath = path.join(outDir, fileName);
            this._set(job, {
              phase: 'sampling',
              message: `${shortName}: sheet ${p + 1}/${plan.panels.length} (${panel.times.length} frames)`,
              progress: Math.round(base + span * (0.15 + (0.8 * p) / plan.panels.length)),
            });
            const result = await contactSheetSmart({
              input: localMedia || chosen.url,
              headers: localMedia ? undefined : chosen.headers,
              outPath: sheetPath,
              duration: pr.duration, cacheDir: ensureDir(CACHE_DIR),
              times: panel.times, cols: panel.cols, rows: panel.rows,
              captions: captionCues,
              onProgress: (frac, msg) => {
                this._set(job, {
                  phase: 'sampling',
                  message: `${shortName} ${plan.panels.length > 1 ? `(sheet ${p + 1}/${plan.panels.length}) ` : ''}${msg}`,
                  progress: Math.round(base + span * (0.15 + (0.8 * (p + Math.min(1, frac))) / plan.panels.length)),
                });
              },
            });
            const relPath = rel(sheetPath);
            panels.push({
              index: p + 1, file: fileName, path: relPath, url: versionedUrl('/sheets/', sheetPath),
              cols: result.cols, rows: result.rows, count: result.count,
              timestamps: result.timestamps, missingFrames: result.failedFrames,
            });
          }
        } finally {
          if (localMedia) { try { fs.rmSync(localMedia, { force: true }); } catch {} }
          if (job.captions) this._clearCaptions(job, season, ep);
        }
        const first = panels[0];
        const meta = {
          provider: job.provider, providerName: job.providerName, repo: job.repo,
          title: job.title, type: job.type, season, episode: ep,
          label: shortName, window: wInfo, duration: Number(pr.duration.toFixed(1)),
          captions: capInfo,
          durationLabel: secondsToLabel(pr.duration),
          interval: plan.interval, perSheet: plan.perSheet, sheets: plan.sheets,
          cols: first ? first.cols : COLS, rows: first ? first.rows : ROWS,
          count: first ? first.count : COUNT,
          panels,
          stream: { url: chosen.url.slice(0, 400), quality: chosen.quality || 0, server: chosen.server || '', format: chosen.format || '' },
          sheet: first ? first.path : '',
          generatedAt: new Date().toISOString(),
        };
        fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(meta, null, 2));
        for (const panel of panels) {
          job.sheets.push({
            episode: ep,
            label: panels.length > 1 ? `${shortName} #${panel.index}` : shortName,
            duration: meta.duration, durationLabel: meta.durationLabel,
            cols: panel.cols, rows: panel.rows, count: panel.count,
            interval: plan.interval, timestamps: panel.timestamps,
            path: panel.path, url: panel.url, quality: chosen.quality || 0,
            captions: capInfo,
            panel: panel.index, panels: panels.length,
          });
        }
        // Written after job.sheets is filled, so the title index lists this episode.
        this._writeTitleIndex(sheetRoot, job);
        this._log(job, `Saved ${shortName}: ${panels.length} sheet(s), ${plan.totalFrames} frames, every ${plan.interval}s`);
      } catch (e) {
        job.errors.push({ episode: ep, stage: 'episode', message: e.message });
        this._log(job, `Failed ${shortName}: ${e.message}`);
        try {
          fs.writeFileSync(path.join(outDir, 'error.json'), JSON.stringify({ error: e.message, at: new Date().toISOString() }, null, 2));
        } catch {}
      }
      this._set(job, { progress: Math.round(base + span) });
    }

    const cancelled = job.cancelRequested;
    job.finishedAt = Date.now();
    this._set(job, {
      status: cancelled ? 'cancelled' : (job.sheets.length ? 'done' : 'failed'),
      phase: cancelled ? 'cancelled' : (job.sheets.length ? 'done' : 'failed'),
      message: cancelled ? 'Cancelled'
        : job.sheets.length ? `Done: ${job.sheets.length} sheet(s)` : 'No sheets generated',
      progress: 100,
    });
    this._log(job, job.message);
  }

  async _runClip(job) {
    const provider = registry.get(job.provider);
    const { season, episode: ep } = job.items[0] || { season: 0, episode: 0 };
    const clipRoot = path.join(ROOT, 'extensions', job.repo, 'clips',
      sanitizeName(job.providerName), job.title);
    const folder = epFolder(season, ep, job.type);
    const outDir = path.join(clipRoot, folder);
    ensureDir(outDir);
    const shortName = job.type === 'series' ? folder : 'Movie';
    const baseName = `clip_${stamp(job.clip.start)}_${Math.round(job.clip.duration)}s`;
    const outPath = path.join(outDir, `${baseName}.mp4`);
    try {
      this._set(job, { phase: 'resolving', message: `Resolving stream for ${shortName}`, progress: 5 });
      let chosen = null, pr = null, result = null;
      let start = job.clip.start, duration = job.clip.duration;
      /* Two passes: a cut can fail on a rate-limited / expired stream URL even
         after probing fine — re-resolve fresh URLs once and cut again. */
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          ({ stream: chosen, probe: pr } = await resolveStream(provider, job, season, ep));
          if (job.cancelRequested) throw new Error('cancelled');
          start = Math.min(job.clip.start, Math.max(0, pr.duration - 1));
          duration = Math.min(job.clip.duration, Math.max(0.5, pr.duration - start));
          this._set(job, {
            phase: 'cutting',
            message: `Cutting ${secondsToLabel(start)} +${Math.round(duration)}s from ${shortName}`,
            progress: 35,
          });
          result = typeof provider.fetchClip === 'function'
            ? await provider.fetchClip({
              id: job.id_, episode: ep, quality: job.quality,
              start, duration, out: outPath,
            })
            : await clip({
              input: chosen.url, headers: chosen.headers,
              audioInput: chosen.audioUrl, audioHeaders: chosen.audioHeaders,
              out: outPath,
              start, duration,
            });
          break;
        } catch (e) {
          if (e.message === 'cancelled' || !isStreamError(e) || attempt === 2) throw e;
          this._log(job, `Stream failed (${e.message.slice(0, 120)}); re-resolving with fresh URLs`);
          if (typeof provider.invalidate === 'function') provider.invalidate(job.id_);
          this._set(job, { phase: 'resolving', message: 'Stream failed — re-resolving fresh URLs', progress: 15 });
        }
      }
      if (!result) throw new Error('clip produced no data');
      const meta = {
        provider: job.provider, providerName: job.providerName, repo: job.repo,
        title: job.title, type: job.type, season, episode: ep, label: shortName,
        sourceDuration: Number(pr.duration.toFixed(1)),
        start: Number(start.toFixed(2)), duration: Number(duration.toFixed(2)),
        startLabel: secondsToLabel(start), durationLabel: secondsToLabel(duration),
        bytes: result.bytes, cutMode: result.mode,
        file: rel(outPath), url: '/clips/' + encodePath(repoRel(outPath)),
        stream: { url: chosen.url.slice(0, 400), quality: chosen.quality || 0, server: chosen.server || '', format: chosen.format || '', audio: !!chosen.audioUrl },
        generatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(outDir, baseName + '.json'), JSON.stringify(meta, null, 2));
      job.clips.push({
        label: shortName, start: meta.start, duration: meta.duration,
        startLabel: meta.startLabel, durationLabel: meta.durationLabel,
        bytes: meta.bytes, path: rel(outPath), url: meta.url,
        quality: chosen.quality || 0,
      });
      this._set(job, {
        status: 'done', phase: 'done', progress: 100,
        message: `Clip ready: ${secondsToLabel(start)} +${Math.round(duration)}s (${(result.bytes / 1e6).toFixed(1)} MB)`,
        finishedAt: Date.now(),
      });
      this._log(job, job.message);
      return;
    } catch (e) {
      const cancelled = job.cancelRequested || e.message === 'cancelled';
      job.errors.push({ episode: ep, stage: 'clip', message: e.message });
      this._set(job, {
        status: cancelled ? 'cancelled' : 'failed',
        phase: cancelled ? 'cancelled' : 'failed',
        message: cancelled ? 'Cancelled' : 'Clip failed: ' + e.message,
        progress: 100, finishedAt: Date.now(),
      });
      try {
        fs.writeFileSync(path.join(outDir, baseName + '.error.json'),
          JSON.stringify({ error: e.message, at: new Date().toISOString() }, null, 2));
      } catch {}
      this._log(job, job.message);
    }
  }

  /* Video -> PDF: download the whole video, decode every frame at job.fps,
     embed the JPEGs as PDF pages, then delete the video and the frames. */
  async _runPdf(job) {
    const provider = registry.get(job.provider);
    const { season, episode: ep } = job.items[0] || { season: 0, episode: 0 };
    const pdfRoot = path.join(ROOT, 'extensions', job.repo, 'pdfs',
      sanitizeName(job.providerName), job.title);
    ensureDir(pdfRoot);
    const outPath = path.join(pdfRoot, `frames-${job.fps}fps-${job.frameWidth}w.pdf`);
    const framesDir = path.join(CACHE_DIR, `pdf-${job.id}-frames`);
    let media = null;
    try {
      if (typeof provider.fetchFile !== 'function') {
        throw new Error(`${job.providerName} has no whole-video download (fetchFile)`);
      }
      this._set(job, {
        phase: 'downloading',
        message: `Downloading the whole video for ${job.title}`,
        progress: 8,
      });
      media = await provider.fetchFile({
        id: job.id_, episode: ep, quality: job.quality,
        maxHeight: 720,
        out: path.join(CACHE_DIR, `pdf-media-${job.id}.mp4`),
      });
      if (job.cancelRequested) throw new Error('cancelled');
      const pr = await probe(media, {});
      const expected = Math.ceil(pr.duration * job.fps);
      if (expected > 30000) {
        throw new Error(`too many frames: ${expected.toLocaleString()} at ${job.fps} fps `
          + '(limit 30,000). Lower the fps or cut the video first.');
      }
      this._set(job, {
        phase: 'frames',
        message: `Extracting ${expected.toLocaleString()} frames at ${job.fps} fps`,
        progress: 25,
      });
      await extractFrames({ input: media, outDir: framesDir, fps: job.fps, width: job.frameWidth });
      const files = fs.readdirSync(framesDir).filter(f => /\.jpe?g$/i.test(f));
      if (!files.length) throw new Error('frame extraction produced no images');
      this._set(job, {
        phase: 'pdf',
        message: `Building PDF from ${files.length.toLocaleString()} frames`,
        progress: 65,
      });
      const pages = await buildPdf({ framesDir, out: outPath });
      const meta = {
        provider: job.provider, providerName: job.providerName, repo: job.repo,
        title: job.title, type: job.type, season, episode: ep,
        sourceDuration: Number(pr.duration.toFixed(1)), durationLabel: secondsToLabel(pr.duration),
        fps: job.fps, width: job.frameWidth, pages,
        bytes: fs.statSync(outPath).size,
        file: rel(outPath), url: versionedUrl('/pdfs/', outPath),
        generatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(outPath.replace(/\.pdf$/i, '.json'), JSON.stringify(meta, null, 2));
      // A previous failed attempt may have left an error sidecar next to this path.
      try { fs.rmSync(outPath.replace(/\.pdf$/i, '.error.json'), { force: true }); } catch {}
      job.pdfs.push({
        label: job.title, pages, fps: job.fps, width: job.frameWidth,
        duration: meta.sourceDuration, durationLabel: meta.durationLabel,
        bytes: meta.bytes, path: meta.file, url: meta.url,
      });
      this._set(job, {
        status: 'done', phase: 'done', progress: 100,
        message: `PDF ready: ${pages.toLocaleString()} pages (${(meta.bytes / 1e6).toFixed(1)} MB)`,
        finishedAt: Date.now(),
      });
      this._log(job, job.message);
    } catch (e) {
      const cancelled = job.cancelRequested || e.message === 'cancelled';
      job.errors.push({ episode: ep, stage: 'pdf', message: e.message });
      this._set(job, {
        status: cancelled ? 'cancelled' : 'failed',
        phase: cancelled ? 'cancelled' : 'failed',
        message: cancelled ? 'Cancelled' : 'PDF failed: ' + e.message,
        progress: 100, finishedAt: Date.now(),
      });
      try {
        fs.writeFileSync(outPath.replace(/\.pdf$/i, '.error.json'),
          JSON.stringify({ error: e.message, at: new Date().toISOString() }, null, 2));
      } catch {}
      this._log(job, job.message);
    } finally {
      if (media) { try { fs.rmSync(media, { force: true }); } catch {} }
      try { fs.rmSync(framesDir, { recursive: true, force: true }); } catch {}
    }
  }

  /* Remove the temporary caption track a sheet job downloaded. */
  _clearCaptions(job, season, ep) {
    const prefix = `captions-${job.id}-${season}-${ep}`;
    try {
      for (const f of fs.readdirSync(CACHE_DIR)) {
        if (f === prefix || f.startsWith(prefix + '.')) {
          try { fs.rmSync(path.join(CACHE_DIR, f), { force: true }); } catch { /* ignore */ }
        }
      }
    } catch { /* cache dir missing */ }
  }

  _writeTitleIndex(sheetRoot, job) {
    const file = path.join(sheetRoot, 'index.json');
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    const entries = new Map((prev.sheets || []).map(s => [s.label, s]));
    for (const s of job.sheets) {
      entries.set(s.label, {
        episode: s.episode, label: s.label, duration: s.duration,
        durationLabel: s.durationLabel, cols: s.cols, rows: s.rows, count: s.count,
        interval: s.interval || 0, path: s.path, quality: s.quality, captions: s.captions || null,
      });
    }
    const sheets = [...entries.values()].sort((a, b) => (a.label < b.label ? -1 : 1));
    const plan = job.plan ? {
      interval: job.plan.interval, perSheet: job.plan.perSheet,
      sheets: job.plan.sheets, totalFrames: job.plan.totalFrames,
      duration: job.plan.duration, durationLabel: secondsToLabel(job.plan.duration || 0),
    } : null;
    fs.writeFileSync(file, JSON.stringify({
      provider: job.provider, providerName: job.providerName, repo: job.repo,
      title: job.title, type: job.type, updatedAt: new Date().toISOString(),
      plan, sheets,
    }, null, 2));
  }
}

module.exports = { Jobs, rel, stamp, resolveStream, isStreamError };
