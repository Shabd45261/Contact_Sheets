'use strict';
/* YouTube provider — native YouTube content as an edit source: music videos,
   official trailers, creator videos, UGC and Shorts. It is NOT a film/series
   rip substitute (AGENTS.md rule 5): a movie or episode belongs to the
   moviebox/castle providers, never to YouTube.

   Search accepts keywords, a pasted watch / Shorts / youtu.be link, a bare
   11-character video id, or a playlist / channel link (returned as a series).
     - keyword search: InnerTube API (public web client), yt-dlp ytsearch fallback
     - pasted link:    resolved with yt-dlp
   Detail: yt-dlp -J (single video) or --flat-playlist -J (playlist / channel).
   Streams: yt-dlp -J pairing a video-only format with an audio-only format —
   YouTube serves them separately, so every candidate carries audioUrl next to
   url; clips mux both (app\lib\ffmpeg.js clip), sheets read the video track only.

   Requires the yt-dlp binary: YTDLP_PATH, tools\yt-dlp\yt-dlp.exe, the WinGet
   links folder or PATH (scripts\env.ps1 wires it up). */
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const { request, UA_DESKTOP, secondsToLabel, ensureDir } = require('../util');

const ROOT = path.join(__dirname, '..', '..', '..');

/* InnerTube: the internal JSON API youtube.com itself uses. The key below is
   the public web key shipped inside every player build; no account needed. */
const IT_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const IT_CTX = { context: { client: { clientName: 'WEB', clientVersion: '2.20240401.00.00', hl: 'en', gl: 'US' } } };
/* "Type: Video" search filter (base64 of the SearchFilter proto). */
const IT_FILTER_VIDEO = 'EgIQAQ==';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const LIST_PREFIX = /^(PL|UU|FL|OL|RD|LL|WL|UL)/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{20,}$/;
const YT_HOST = /(^|\.)(youtube\.com|youtu\.be)$/i;

function thumbFor(id) { return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`; }

/* "2:55" / "1:02:03" / "LIVE" -> seconds (0 when not a clock). */
function parseClockText(t) {
  if (!t) return 0;
  const parts = String(t).trim().split(':').map(Number);
  if (!parts.length || parts.some(n => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function compactCount(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(v);
}

/* What was typed into the search box: a video, a playlist/channel, or keywords?
   Returns { videoId } | { listId } | null (plain keyword search). */
function parseRef(query) {
  const s = String(query || '').trim();
  if (!s) return null;
  if (VIDEO_ID.test(s)) return { videoId: s };
  if (LIST_PREFIX.test(s) && !s.includes('/') && s.length >= 10) return { listId: s };
  if (CHANNEL_ID.test(s)) return { listId: `https://www.youtube.com/channel/${s}` };
  if (!/^https?:\/\//i.test(s) && !/^(www\.|m\.|music\.)?(youtube\.com|youtu\.be)/i.test(s)) return null;
  let u;
  try { u = new URL(/^https?:/i.test(s) ? s : 'https://' + s); } catch { return null; }
  if (!YT_HOST.test(u.hostname.replace(/:\d+$/, ''))) return null;
  const v = u.searchParams.get('v');
  if (v && VIDEO_ID.test(v)) return { videoId: v };
  const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
  if (m) return { videoId: m[1] };
  /* youtu.be carries the id in the path: https://youtu.be/<id>[?t=30] */
  if (/^youtu\.be$/i.test(u.hostname.replace(/:\d+$/, ''))) {
    const mm = u.pathname.match(/^\/([A-Za-z0-9_-]{11})$/);
    if (mm) return { videoId: mm[1] };
  }
  const list = u.searchParams.get('list');
  if (list) return { listId: list };
  if (u.pathname === '/' || u.pathname === '/watch' || u.pathname.startsWith('/results')) return null;
  /* Anything else on a youtube.com host: channel page, @handle, /c/, /user/. */
  return { listId: u.toString() };
}

/* Is this id a playlist / channel (rather than a single video)? */
function isListLike(id) {
  const s = String(id || '');
  return (LIST_PREFIX.test(s) && !s.includes('/') && s.length >= 10)
    || CHANNEL_ID.test(s)
    || /^https?:\/\//i.test(s);
}

class YouTube {
  constructor(meta = {}) {
    this.id = meta.id || 'youtube';
    this.name = meta.name || 'YouTube';
    this.repo = meta.repo || 'youtube';
    this.plugin = meta.plugin || 'YouTubeProvider';
    this.pluginUrl = meta.pluginUrl || '';
    this._bin = null;
    this._infoCache = new Map();  /* videoId -> { at, info } (full yt-dlp JSON) */
    this._listCache = new Map();  /* listId  -> { at, info } (flat playlist JSON) */
  }

  /* ---------- yt-dlp plumbing ---------------------------------------- */

  _binPath() {
    if (this._bin) return this._bin;
    const candidates = [
      process.env.YTDLP_PATH,
      path.join(ROOT, 'tools', 'yt-dlp', 'yt-dlp.exe'),
      'C:\\Users\\DELL\\AppData\\Local\\Microsoft\\WinGet\\Links\\yt-dlp.exe',
      'C:\\HostDrives\\C\\Users\\DELL\\AppData\\Local\\Microsoft\\WinGet\\Links\\yt-dlp.exe',
      'yt-dlp', 'yt-dlp.exe',
    ].filter(Boolean);
    for (const c of candidates) {
      try {
        const r = spawnSync(c, ['--version'], { windowsHide: true, timeout: 20000, encoding: 'utf8' });
        if (r.status === 0) { this._bin = c; return c; }
      } catch { /* try next */ }
    }
    throw new Error('yt-dlp not found — the YouTube provider needs it. Install it (winget install yt-dlp), put it in tools\\yt-dlp\\, or set YTDLP_PATH.');
  }

  _ytDlp(args, timeout = 120000) {
    const bin = this._binPath();
    return new Promise((resolve, reject) => {
      const p = spawn(bin, args, { windowsHide: true });
      let out = '', err = '';
      const timer = setTimeout(() => { try { p.kill(); } catch {} reject(new Error('yt-dlp timed out')); }, timeout);
      p.stdout.on('data', d => { out += d; });
      p.stderr.on('data', d => { err += d; });
      p.on('error', e => { clearTimeout(timer); reject(new Error(`yt-dlp failed to start: ${e.message}`)); });
      p.on('close', code => {
        clearTimeout(timer);
        if (code === 0) return resolve(out);
        const msg = (err || out).trim().split('\n').filter(Boolean).slice(-2).join(' | ');
        reject(new Error(`yt-dlp exited ${code}${msg ? ': ' + msg : ''}`.slice(0, 240)));
      });
    });
  }

  async _json(args, timeout) {
    const out = await this._ytDlp(['-J', '--no-warnings', ...args], timeout);
    try { return JSON.parse(out); } catch { throw new Error('yt-dlp returned unparseable JSON'); }
  }

  _remember(cache, key, info) {
    if (cache.size >= 40) cache.delete(cache.keys().next().value);
    cache.set(key, { at: Date.now(), info });
  }

  /* Full metadata + formats for one video. googlevideo URLs live ~6 h, so a
     20-minute cache is safe and keeps repeated probes cheap. */
  async _info(videoId) {
    const hit = this._infoCache.get(videoId);
    if (hit && Date.now() - hit.at < 20 * 60 * 1000) return hit.info;
    const info = await this._json(['--no-playlist', `https://www.youtube.com/watch?v=${videoId}`], 120000);
    this._remember(this._infoCache, videoId, info);
    return info;
  }

  /* Flat playlist / channel listing (ids + titles only, one request). */
  async _listInfo(listId) {
    const key = String(listId);
    const hit = this._listCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.info;
    const url = /^https?:/i.test(key) ? key : `https://www.youtube.com/playlist?list=${encodeURIComponent(key)}`;
    const info = await this._json(['--flat-playlist', '--playlist-items', '1:200', url], 240000);
    this._remember(this._listCache, key, info);
    return info;
  }

  /* ---------- provider interface ------------------------------------- */

  async search(query) {
    const ref = parseRef(query);
    if (ref) {
      if (ref.videoId) {
        const info = await this._info(ref.videoId);
        return { items: [this._videoItem(info)], total: 1 };
      }
      const info = await this._listInfo(ref.listId);
      return { items: [this._listItem(info, ref.listId)], total: 1 };
    }
    try {
      return await this._innertubeSearch(String(query));
    } catch { /* InnerTube refused (bot check or layout change): yt-dlp */ }
    const items = await this._ytdlpSearch(String(query));
    return { items, total: items.length };
  }

  async detail(id) {
    const key = String(id || '');
    if (VIDEO_ID.test(key)) return this._videoDetail(key);
    if (isListLike(key)) return this._listDetail(key);
    throw new Error(`YouTube: "${key}" is not a video id, playlist id or YouTube URL`);
  }

  async streams({ id, episode, quality } = {}) {
    let videoId = String(id || '');
    if (!VIDEO_ID.test(videoId)) {
      const ref = parseRef(videoId);
      if (ref && ref.videoId) videoId = ref.videoId;
    }
    if (!VIDEO_ID.test(videoId)) {
      if (!isListLike(videoId)) throw new Error(`YouTube: unknown id "${videoId}"`);
      const list = await this._listInfo(videoId);
      const entries = (list.entries || []).filter(e => e && e.id);
      const n = Number(episode) || 1;
      const ep = entries[n - 1];
      if (!ep) throw new Error(`YouTube: episode ${n} is not in this playlist`);
      videoId = ep.id;
    }
    const info = await this._info(videoId);
    if (info.is_live || info.live_status === 'is_live') {
      throw new Error('YouTube: live streams are not supported');
    }
    const cands = this._candidates(info, Number(quality) || 0);
    if (!cands.length) {
      throw new Error('YouTube: no downloadable formats (members-only, region-locked or removed video)');
    }
    return cands;
  }

  /* Drop cached formats for an id so the next resolve gets fresh googlevideo
     URLs — they expire (~6 h) and get intermittently rate-limited (HTTP 403)
     when resolved repeatedly from the same IP. Called by the clip/sheet retry. */
  invalidate(id) {
    const key = String(id || '');
    if (VIDEO_ID.test(key)) this._infoCache.delete(key);
    else { this._infoCache.clear(); this._listCache.clear(); }
  }

  /* ---------- item/detail shapes -------------------------------------- */

  _videoItem(info) {
    const secs = Number(info.duration) || 0;
    const views = Number(info.view_count) || 0;
    return {
      id: info.id,
      title: info.title || 'Untitled video',
      year: String(info.upload_date || '').slice(0, 4),
      poster: info.thumbnail || thumbFor(info.id),
      type: 'movie',
      subtitle: [
        info.channel || info.uploader || 'YouTube',
        secs ? secondsToLabel(secs) : '',
        views ? `${compactCount(views)} views` : '',
      ].filter(Boolean).join(' · '),
      durationSec: secs,
    };
  }

  _listItem(info, listId) {
    const entries = (info.entries || []).filter(e => e && e.id);
    return {
      id: listId,
      title: info.title || info.uploader || 'Playlist',
      year: '',
      poster: entries[0] ? thumbFor(entries[0].id) : '',
      type: 'series',
      subtitle: [info.uploader || '', `${entries.length} video(s)`].filter(Boolean).join(' · '),
    };
  }

  async _videoDetail(videoId) {
    const info = await this._info(videoId);
    const secs = Number(info.duration) || 0;
    const heights = this._heights(info);
    return {
      id: info.id,
      title: info.title || 'Untitled video',
      year: String(info.upload_date || '').slice(0, 4),
      poster: info.thumbnail || thumbFor(info.id),
      backdrop: info.thumbnail || '',
      plot: String(info.description || '').slice(0, 400),
      rating: '',
      type: 'movie',
      tags: (info.tags || []).slice(0, 6),
      qualities: heights.length ? heights.slice(0, 6) : [720, 480, 360],
      duration: secs,
      channel: info.channel || info.uploader || '',
      channelId: info.channel_id || '',
      seasons: [{
        season: 0,
        name: 'Video',
        episodes: [{ id: info.id, number: 0, season: 0, title: info.title || 'Video', duration: secs }],
      }],
    };
  }

  async _listDetail(listId) {
    const info = await this._listInfo(listId);
    const entries = (info.entries || []).filter(e => e && e.id).slice(0, 200);
    return {
      id: listId,
      title: info.title || info.uploader || 'Playlist',
      year: '',
      poster: entries[0] ? thumbFor(entries[0].id) : '',
      plot: `${info.title || 'Playlist'} · ${entries.length} video(s)${info.uploader ? ` · ${info.uploader}` : ''}`,
      rating: '',
      type: 'series',
      qualities: [1080, 720, 480, 360],
      channel: info.uploader || info.channel || '',
      seasons: [{
        season: 1,
        name: info.title || 'Playlist',
        episodes: entries.map((e, i) => ({
          id: e.id, number: i + 1, season: 1,
          title: e.title || `Video ${i + 1}`, duration: Number(e.duration) || 0,
        })),
      }],
    };
  }

  /* ---------- format ladders ------------------------------------------ */

  _formats(info) {
    const fmts = (info.formats || []).filter(f => f && f.url && f.ext !== 'mhtml');
    const hasV = f => f.vcodec && f.vcodec !== 'none';
    const hasA = f => f.acodec && f.acodec !== 'none';
    return {
      video: fmts.filter(f => hasV(f) && !hasA(f)),
      audio: fmts.filter(f => !hasV(f) && hasA(f)),
      combined: fmts.filter(f => hasV(f) && hasA(f)),
    };
  }

  _heights(info) {
    const { video, combined } = this._formats(info);
    return [...new Set([...video, ...combined].map(f => f.height).filter(Boolean))].sort((a, b) => b - a);
  }

  /* avc1/mp4 pairs mux cleanly into the clip container; https URLs seek fast. */
  _bestVideoAt(video, height) {
    const score = f => (/^https?$/.test(f.protocol || 'https') ? 4 : 0)
      + (String(f.vcodec || '').startsWith('avc1') ? 3 : /vp9|vp09/.test(String(f.vcodec)) ? 2 : String(f.vcodec || '').startsWith('av01') ? 1 : 0);
    return video.filter(f => f.height === height)
      .sort((a, b) => score(b) - score(a))[0] || null;
  }

  /* Original audio only: YouTube marks auto-dubbed tracks with an
     "acont=dubbed-auto" xtag inside the stream URL. Prefer the original
     language, then the mp4a family, then bitrate. */
  _bestAudio(audio) {
    const isDubbed = f => /dubbed/i.test(String(f.url || '') + String(f.xtags || ''));
    const score = f => (isDubbed(f) ? 0 : 8)
      + (String(f.acodec || '').startsWith('mp4a') ? 4 : 0)
      + (/^https?$/.test(f.protocol || 'https') ? 2 : 0)
      + (Number(f.abr) || 0) / 1000;
    return audio.slice().sort((a, b) => score(b) - score(a))[0] || null;
  }

  _candidates(info, want) {
    const { video, audio, combined } = this._formats(info);
    const heights = this._heights(info);
    const order = want > 0
      ? [...heights.filter(h => h <= want), ...heights.filter(h => h > want)]
      : heights;
    const bestAudio = this._bestAudio(audio);
    const out = [];
    for (const h of order) {
      if (out.length >= 3) break;
      const v = this._bestVideoAt(video, h);
      if (!v) continue;
      out.push({
        url: v.url,
        audioUrl: bestAudio ? bestAudio.url : undefined,
        videoFormatId: v.format_id || String(v.itag || ''),
        audioFormatId: bestAudio ? (bestAudio.format_id || String(bestAudio.itag || '')) : '',
        quality: h, resolution: h,
        format: v.ext || 'mp4', server: 'youtube',
        note: v.protocol === 'm3u8' ? 'hls' : '',
        headers: {}, audioHeaders: {},
      });
    }
    /* Older / simple videos sometimes ship combined formats only. */
    if (!out.length && combined.length) {
      const c = combined.slice().sort((a, b) => (b.height || 0) - (a.height || 0))[0];
      out.push({
        url: c.url, quality: c.height || 360, resolution: c.height || 0,
        videoFormatId: c.format_id || String(c.itag || ''), audioFormatId: '',
        format: c.ext || 'mp4', server: 'youtube', note: 'muxed', headers: {},
      });
    }
    return out;
  }

  /* ---------- yt-dlp fetching (clips + sheet sources) -----------------
     googlevideo throttles plain ffmpeg reads to a trickle and intermittently
     403s them, so heavy fetching goes through yt-dlp's own downloader: it is
     range-aware, throttle-tolerant and muxes the video/audio pair itself. */

  /* Resolve the (videoId, format) pair a fetch needs. For a playlist /
     channel id the episode number picks the video (same as streams()). */
  async _fetchTarget({ id, episode, quality, maxHeight }) {
    let videoId = String(id || '');
    /* A pasted watch / Shorts / youtu.be URL is a video, not a playlist. */
    if (!VIDEO_ID.test(videoId)) {
      const ref = parseRef(videoId);
      if (ref && ref.videoId) videoId = ref.videoId;
    }
    if (!VIDEO_ID.test(videoId)) {
      if (!isListLike(videoId)) throw new Error(`YouTube: unknown id "${videoId}"`);
      const list = await this._listInfo(videoId);
      const entries = (list.entries || []).filter(e => e && e.id);
      const ep = entries[(Number(episode) || 1) - 1];
      if (!ep) throw new Error(`YouTube: episode ${Number(episode) || 1} is not in this playlist`);
      videoId = ep.id;
    }
    const streams = await this.streams({ id: videoId, episode, quality });
    const want = Number(quality) || 0;
    const cand = (want > 0 ? streams : streams.slice()
      .sort((a, b) => Math.abs((a.quality || 0) - (maxHeight || 720)) - Math.abs((b.quality || 0) - (maxHeight || 720))))[0] || streams[0];
    if (!cand) throw new Error('YouTube: no stream candidate to fetch');
    return { videoId, cand };
  }

  /* Cut a time range out of a video with yt-dlp's section downloader and
     return { bytes, mode }. Much faster and sturdier than ffmpeg on a
     throttled googlevideo URL: exact format pair + ranged section download. */
  async fetchClip({ id, episode, quality, start = 0, duration = 30, out } = {}) {
    const startS = Math.max(0, Number(start) || 0);
    const durS = Math.max(0.5, Number(duration) || 30);
    const { videoId, cand } = await this._fetchTarget({ id, episode, quality, maxHeight: 720 });
    const q = cand.quality || 720;
    const pair = cand.audioFormatId
      ? `${cand.videoFormatId}+${cand.audioFormatId}`
      : cand.videoFormatId || `bv*[height<=${q}]+ba/b[height<=${q}]`;
    const fallback = `bv*[height<=${q}]+ba/b[height<=${q}]`;
    const fexpr = /^bv|^b\[/.test(pair) ? pair : `${pair}/${fallback}`;
    ensureDir(path.dirname(out));
    try {
      await this._ytDlp([
        '-f', fexpr,
        '--download-sections', `*${startS.toFixed(2)}-${(startS + durS).toFixed(2)}`,
        '--merge-output-format', 'mp4',
        '--force-overwrites', '--no-part', '--no-playlist', '--no-warnings',
        '-o', out, `https://www.youtube.com/watch?v=${videoId}`,
      ], 5 * 60 * 1000);
    } catch (e) {
      try { fs.rmSync(out, { force: true }); } catch {}
      throw e;
    }
    const bytes = fs.existsSync(out) ? fs.statSync(out).size : 0;
    if (bytes < 2048) {
      try { fs.rmSync(out, { force: true }); } catch {}
      throw new Error('yt-dlp section download produced no data');
    }
    return { bytes, mode: 'ytdlp-section' };
  }

  /* Download a whole video (video-only track, low res is plenty for sheets)
     to a local file for fast local sampling. Returns the local path. */
  async fetchFile({ id, episode, quality, maxHeight = 480, out } = {}) {
    const { videoId, cand } = await this._fetchTarget({ id, episode, quality, maxHeight });
    const q = cand.quality || maxHeight;
    const fexpr = /^bv|^b\[/.test(cand.videoFormatId || '')
      ? cand.videoFormatId
      : `${cand.videoFormatId}/bv*[height<=${q}][vcodec^=avc1]/bv*[height<=${q}]`;
    ensureDir(path.dirname(out));
    try {
      await this._ytDlp([
        '-f', fexpr,
        '--force-overwrites', '--no-part', '--no-playlist', '--no-warnings',
        '-o', out, `https://www.youtube.com/watch?v=${videoId}`,
      ], 10 * 60 * 1000);
    } catch (e) {
      try { fs.rmSync(out, { force: true }); } catch {}
      throw e;
    }
    if (!fs.existsSync(out) || fs.statSync(out).size < 1024) {
      try { fs.rmSync(out, { force: true }); } catch {}
      throw new Error('yt-dlp download produced no data');
    }
    return out;
  }

  /* ---------- captions -------------------------------------------------
     YouTube ships its own caption tracks (manual + auto-generated). A sheet
     job asks for them, this method downloads the chosen track as SRT and the
     sheet engine burns the line that belongs to each sampled frame. */

  /* Pick a caption track from the -J metadata: `want` is an exact tag or a
     language ("en" matches en, en-US, ...); "auto"/blank uses the default
     preference — manual English, any manual track, auto English, any auto. */
  _pickCaptionTrack(info, want) {
    const manual = (info && info.subtitles) || {};
    const auto = (info && info.automatic_captions) || {};
    const usable = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k)
      && (!Array.isArray(obj[k]) || obj[k].length > 0);
    const preference = obj => {
      const keys = Object.keys(obj).filter(k => usable(obj, k));
      const out = [];
      const push = k => { if (k && usable(obj, k) && !out.includes(k)) out.push(k); };
      for (const k of ['en', 'en-US', 'en-GB', 'en-orig']) push(k);
      const enRest = keys.filter(k => /^en([-_]|$)/i.test(k)).sort();
      for (const k of enRest) push(k);
      for (const k of keys.slice().sort()) push(k);
      return out;
    };
    const needle = String(want || '').trim();
    if (needle && needle !== 'auto') {
      const lower = needle.toLowerCase();
      for (const [source, obj] of [['manual', manual], ['auto', auto]]) {
        const hit = Object.keys(obj).find(k => k.toLowerCase() === lower
          || k.toLowerCase().startsWith(lower + '-'));
        if (hit && usable(obj, hit)) return { lang: hit, source };
      }
    }
    for (const [source, obj] of [['manual', manual], ['auto', auto]]) {
      const keys = preference(obj);
      if (keys.length) return { lang: keys[0], source };
    }
    return null;
  }

  /* List the caption tracks YouTube offers for this video (manual + auto).
     Used by the UI to populate the caption-language dropdown. */
  async listCaptions({ id, episode } = {}) {
    let videoId = String(id || '');
    if (!VIDEO_ID.test(videoId)) {
      const ref = parseRef(videoId);
      if (ref && ref.videoId) videoId = ref.videoId;
    }
    if (!VIDEO_ID.test(videoId)) {
      if (!isListLike(videoId)) throw new Error(`YouTube: unknown id "${videoId}"`);
      const list = await this._listInfo(videoId);
      const entries = (list.entries || []).filter(e => e && e.id);
      const ep = entries[(Number(episode) || 1) - 1];
      if (!ep) throw new Error(`YouTube: episode ${Number(episode) || 1} is not in this playlist`);
      videoId = ep.id;
    }
    const info = await this._info(videoId);
    const manual = (info && info.subtitles) || {};
    const auto = (info && info.automatic_captions) || {};
    const usable = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k)
      && (!Array.isArray(obj[k]) || obj[k].length > 0);
    const origLang = String(info && info.language || '').trim();
    const manualLangs = Object.keys(manual).filter(k => usable(manual, k));
    const tracks = [];
    // Manual tracks first.
    for (const lang of manualLangs) {
      tracks.push({ lang, source: 'manual', label: `${lang} (manual)` });
    }
    // Auto tracks: only the original-language track(s) and any language that
    // also has a manual track (so the user can pick auto vs manual). This
    // drops the ~150 auto-translated tracks YouTube generates on demand.
    const autoLangs = Object.keys(auto).filter(k => usable(auto, k));
    for (const lang of autoLangs) {
      const isOrig = origLang && (lang === origLang || lang === origLang + '-orig' || lang === 'en-orig' && origLang === 'en');
      const hasManual = manualLangs.some(m => m.toLowerCase() === lang.toLowerCase() || m.toLowerCase().startsWith(lang.toLowerCase() + '-'));
      if (isOrig || hasManual) {
        // avoid duplicating a manual track with the same lang
        if (!manualLangs.some(m => m.toLowerCase() === lang.toLowerCase())) {
          tracks.push({ lang, source: 'auto', label: `${lang} (auto)` });
        }
      }
    }
    tracks.sort((a, b) => (a.source === b.source
      ? a.lang.localeCompare(b.lang)
      : (a.source === 'manual' ? -1 : 1)));
    return { videoId, tracks, originalLanguage: origLang || null };
  }

  /* Download one caption track as SRT. `out` is a base path (no extension);
     yt-dlp writes <base>.<lang>.srt and the newest matching file is returned.
     Throws when the video has no captions at all. */
  async fetchCaptions({ id, episode, lang, out, format = 'srt' } = {}) {
    let videoId = String(id || '');
    if (!VIDEO_ID.test(videoId)) {
      const ref = parseRef(videoId);
      if (ref && ref.videoId) videoId = ref.videoId;
    }
    if (!VIDEO_ID.test(videoId)) {
      if (!isListLike(videoId)) throw new Error(`YouTube: unknown id "${videoId}"`);
      const list = await this._listInfo(videoId);
      const entries = (list.entries || []).filter(e => e && e.id);
      const ep = entries[(Number(episode) || 1) - 1];
      if (!ep) throw new Error(`YouTube: episode ${Number(episode) || 1} is not in this playlist`);
      videoId = ep.id;
    }
    const info = await this._info(videoId);
    const manual = (info && info.subtitles) || {};
    const auto = (info && info.automatic_captions) || {};
    const usable = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k)
      && (!Array.isArray(obj[k]) || obj[k].length > 0);
    let pick = null;
    const needle = String(lang || '').trim();
    if (needle.includes('::')) {
      const parts = needle.split('::');
      const l = (parts[0] || '').trim();
      const src = (parts[1] || '').trim().toLowerCase();
      const obj = src === 'auto' ? auto : manual;
      if (l && usable(obj, l)) pick = { lang: l, source: src === 'auto' ? 'auto' : 'manual' };
    }
    if (!pick) pick = this._pickCaptionTrack(info, needle);
    if (!pick) throw new Error('YouTube: this video has no captions');

    const fmt = String(format || 'srt').toLowerCase() === 'vtt' ? 'vtt' : 'srt';
    const ext = fmt === 'vtt' ? 'vtt' : 'srt';
    const base = String(out || path.join(ROOT, 'data', 'cache', `captions-${videoId}`)).replace(/\.(srt|vtt)$/i, '');
    const dir = path.dirname(base);
    const stem = path.basename(base);
    ensureDir(dir);
    // Stale tracks from an earlier attempt would otherwise win the newest-file race.
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(stem + '.') && /\.(srt|vtt)$/i.test(f)) fs.rmSync(path.join(dir, f), { force: true });
      }
    } catch { /* cache dir just created */ }

    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this._ytDlp([
          '--skip-download',
          pick.source === 'auto' ? '--write-auto-subs' : '--write-subs',
          '--sub-langs', pick.lang,
          '--convert-subs', fmt,
          '--no-playlist', '--no-warnings',
          '-o', base, `https://www.youtube.com/watch?v=${videoId}`,
        ], 120000);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        const msg = String(e.message || '');
        if (!/429|Too Many Requests/i.test(msg) || attempt === 2) break;
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
    if (lastErr) {
      throw new Error(`YouTube: caption download failed (${lastErr.message.slice(0, 140)})`);
    }

    const file = fs.readdirSync(dir)
      .filter(f => f.startsWith(stem + '.') && new RegExp('\\.' + ext + '$', 'i').test(f))
      .map(f => ({ f, at: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.at - a.at)[0];
    if (!file) throw new Error('YouTube: caption download produced no file');
    return { file: path.join(dir, file.f), lang: pick.lang, source: pick.source, format: fmt };
  }

  /* ---------- search backends ----------------------------------------- */

  async _innertubeSearch(query) {
    const r = await request(`https://www.youtube.com/youtubei/v1/search?key=${IT_KEY}&prettyPrint=false`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': UA_DESKTOP,
        origin: 'https://www.youtube.com',
      },
      body: JSON.stringify({ ...IT_CTX, query, params: IT_FILTER_VIDEO }),
      timeout: 25000,
      retries: 1,
    });
    if (!r.ok) throw new Error(`YouTube search HTTP ${r.status}`);
    const j = r.json();
    const items = [];
    const seen = new Set();
    const walk = o => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) { o.forEach(walk); return; }
      const v = o.videoRenderer;
      if (v && v.videoId && !seen.has(v.videoId)) {
        seen.add(v.videoId);
        const lengthText = (v.lengthText || {}).simpleText || '';
        const views = (v.shortViewCountText || {}).simpleText || (v.viewCountText || {}).simpleText || '';
        const channel = ((((v.shortBylineText || v.ownerText || {}).runs) || [])[0] || {}).text || '';
        items.push({
          id: v.videoId,
          title: (((v.title || {}).runs || [])[0] || {}).text || '',
          year: '',
          poster: ((((v.thumbnail || {}).thumbnails) || []).slice(-1)[0] || {}).url || thumbFor(v.videoId),
          type: 'movie',
          subtitle: [channel, lengthText, views].filter(Boolean).join(' · '),
          durationSec: parseClockText(lengthText),
        });
      }
      for (const k of Object.keys(o)) walk(o[k]);
    };
    walk(j.contents);
    if (!items.length) throw new Error('YouTube search returned no videos');
    return { items: items.slice(0, 24), total: items.length };
  }

  async _ytdlpSearch(query) {
    const info = await this._json(['--flat-playlist', `ytsearch24:${query}`], 120000);
    return (info.entries || []).filter(e => e && e.id).map(e => ({
      id: e.id,
      title: e.title || 'Untitled video',
      year: '',
      poster: thumbFor(e.id),
      type: 'movie',
      subtitle: [
        e.channel || e.uploader || '',
        Number(e.duration) ? secondsToLabel(Number(e.duration)) : '',
        Number(e.view_count) ? `${compactCount(Number(e.view_count))} views` : '',
      ].filter(Boolean).join(' · '),
      durationSec: Number(e.duration) || 0,
    }));
  }
}

module.exports = { YouTube, parseRef, isListLike, thumbFor, parseClockText };
