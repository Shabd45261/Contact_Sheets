'use strict';
/* Contact-sheet engine: ffprobe duration + evenly spaced frames + timestamped 6x5 grid. */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ensureDir, sanitizeName, sleep } = require('./util');
const { isStreamError } = require('./jobs');
const { cueAt, wrapText } = require('./captions');

const COLS = 6;
const ROWS = 5;
const COUNT = COLS * ROWS;
const TILE_W = 320;
const TILE_H = 180;

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

function fontFile() {
  const candidates = [
    'C:/Windows/Fonts/arialbd.ttf',
    'C:/Windows/Fonts/ArialBD.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  ];
  return candidates.find(p => fs.existsSync(p)) || '';
}

function headerArgs(headers) {
  if (!headers) return [];
  const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
  return ['-headers', lines + '\r\n'];
}

/* HLS-only demuxer options (CastleTV serves .jpg segments and needs permissive parsing). */
function pickyArgs(input) {
  return /\.m3u8(\?|$)/i.test(String(input || ''))
    ? ['-allowed_extensions', 'ALL', '-extension_picky', '0']
    : [];
}

function run(bin, args, { timeout = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { try { p.kill(); } catch {} reject(new Error(`${bin} timed out`)); }, timeout);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${bin} exited ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

async function probe(input, { headers } = {}) {
  const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams',
    ...pickyArgs(input), ...headerArgs(headers),
    '-analyzeduration', '8000000', '-probesize', '8000000', input];
  const { out } = await run(FFPROBE, args, { timeout: 60000 });
  const j = JSON.parse(out);
  const v = (j.streams || []).find(s => s.codec_type === 'video') || {};
  const duration = parseFloat((j.format && j.format.duration) || v.duration || '0');
  return {
    duration, width: v.width || 0, height: v.height || 0,
    codec: v.codec_name || '', format: (j.format && j.format.format_name) || '',
    size: parseInt((j.format && j.format.size) || '0', 10),
  };
}

function timestamps(duration, count = COUNT) {
  const span = Math.max(0.5, duration - 1.2);
  const out = [];
  for (let i = 0; i < count; i++) out.push(count === 1 ? 0 : (span * i) / (count - 1));
  return out;
}

/**
 * Work out which timestamps to sample.
 *  - no interval: `count` frames spread evenly across the whole runtime.
 *  - interval > 0: a frame every `interval` seconds starting at 0,
 *    capped at `maxFrames` (so the sheet stays a sane size).
 * The grid is always `cols` wide; rows grow with the frame count.
 */
function framePlan(duration, { count = COUNT, interval = 0, maxFrames = 120, cols = COLS } = {}) {
  const dur = Math.max(0.1, Number(duration) || 0);
  let times;
  if (Number(interval) > 0) {
    const span = Math.max(0.5, dur - 0.5);
    const n = Math.max(1, Math.min(Math.floor(maxFrames), Math.floor(span / Number(interval)) + 1));
    times = Array.from({ length: n }, (_, i) => Number((i * Number(interval)).toFixed(3)));
  } else {
    const n = Math.max(1, Math.min(Math.floor(maxFrames), Math.floor(count) || COUNT));
    times = timestamps(dur, n);
  }
  const rows = Math.max(1, Math.ceil(times.length / cols));
  return { times, cols, rows, count: times.length, interval: Number(interval) || 0 };
}

function labelFor(t) { return `${t.toFixed(1)}s`; }

/**
 * Work out a multi-sheet plan from any two of the three knobs:
 *   interval  — seconds between snapshots
 *   perSheet  — images per contact sheet
 *   sheets    — number of contact sheets
 * Missing values are derived; with only one (or none) sensible defaults fill in.
 */
function planSheets(duration, { interval = 0, perSheet = 0, sheets = 0, cols = COLS, maxPerSheet = 60 } = {}) {
  const dur = Math.max(0.5, Number(duration) || 0);
  let iv = Number(interval) > 0 ? Number(interval) : 0;
  let per = Number(perSheet) > 0 ? Math.max(1, Math.min(maxPerSheet, Math.round(Number(perSheet)))) : 0;
  let n = Number(sheets) > 0 ? Math.max(1, Math.round(Number(sheets))) : 0;

  if (iv && per) n = Math.max(1, Math.ceil(dur / (iv * per)));
  else if (iv && n) per = Math.max(1, Math.min(maxPerSheet, Math.ceil(dur / (iv * n))));
  else if (per && n) iv = dur / (per * n);
  else if (iv) { per = 30; n = Math.max(1, Math.ceil(dur / (iv * per))); }
  else if (per) { n = 1; iv = dur / per; }
  else if (n) { per = 30; iv = dur / (per * n); }
  else { per = 30; n = 1; iv = dur / per; }

  iv = Math.max(0.05, iv);
  const panels = [];
  for (let k = 0; k < n; k++) {
    const times = [];
    for (let i = 0; i < per; i++) {
      const idx = k * per + i;
      const t = Number((idx * iv).toFixed(3));
      if (t > dur - 0.05) break;
      times.push(t);
    }
    if (!times.length) break;
    panels.push({ times, cols, rows: Math.max(1, Math.ceil(times.length / cols)) });
  }
  return {
    interval: Number(iv.toFixed(3)),
    perSheet: per,
    sheets: panels.length || 1,
    totalFrames: panels.reduce((a, p) => a + p.times.length, 0),
    panels: panels.length ? panels : [{ times: timestamps(dur, per), cols, rows: Math.max(1, Math.ceil(per / cols)) }],
  };
}

/* Escape a filesystem path for use inside an ffmpeg filtergraph value. */
function filterPath(p) {
  return String(p).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

/* Draw the caption as a second drawtext pass. The text goes through a
   textfile so quotes/percent signs/commas in the caption cannot break the
   filtergraph; expansion=none stops ffmpeg reading %{...} sequences. */
function captionDraw(caption, out, font) {
  const lines = wrapText(caption, 36, 3);
  if (!lines) return null;
  const textFile = out.replace(/\.jpg$/i, '') + '.cap.txt';
  fs.writeFileSync(textFile, lines + '\n', 'utf8');
  const fontArg = font ? `fontfile='${filterPath(font)}':` : '';
  return `drawtext=${fontArg}textfile='${filterPath(textFile)}':expansion=none`
    + ':x=(w-text_w)/2:y=h-text_h-8:fontsize=15:fontcolor=white'
    + ':box=1:boxcolor=black@0.62:boxborderw=5:line_spacing=2';
}

async function grabFrame({ input, headers, t, width, height, out, font, caption }) {
  const label = labelFor(t);
  const esc = label.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
  const fontArg = font ? `fontfile='${font.replace(/\\/g, '/').replace(/:/g, '\\:')}':` : '';
  const chain = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `drawtext=${fontArg}text='${esc}':x=8:y=8:fontsize=20:fontcolor=yellow:borderw=2:bordercolor=black`,
  ];
  const drawCaption = caption ? captionDraw(caption, out, font) : null;
  if (drawCaption) chain.push(drawCaption);
  const args = ['-hide_banner', '-loglevel', 'error', '-y',
    '-ss', t.toFixed(2), ...pickyArgs(input), ...headerArgs(headers), '-i', input,
    '-map', '0:v:0', '-frames:v', '1', '-vf', chain.join(','), '-q:v', '3', out];
  await run(FFMPEG, args, { timeout: 120000 });
}

/* Extract every frame at a fixed fps into <outDir>/frame_%06d.jpg.
   Used by the video -> PDF job: the whole runtime is decoded once, at a small
   width, so a music video costs a few hundred MB of temporary JPEGs. */
async function extractFrames({ input, outDir, fps = 30, width = 640, timeout = 20 * 60 * 1000 }) {
  ensureDir(outDir);
  const vf = `fps=${Math.max(1, Math.min(60, Math.round(Number(fps) || 30)))},`
    + `scale=${Math.max(160, Math.round(Number(width) || 640))}:-2:flags=lanczos`;
  const args = ['-hide_banner', '-loglevel', 'error', '-y',
    '-i', input, '-vf', vf, '-q:v', '3', '-start_number', '1',
    path.join(outDir, 'frame_%06d.jpg')];
  await run(FFMPEG, args, { timeout });
}

async function blackFrame(out, width, height, label) {
  const font = fontFile();
  const fontArg = font ? `fontfile='${font.replace(/\\/g, '/').replace(/:/g, '\\:')}':` : '';
  const vf = `color=c=black:s=${width}x${height}:d=1,drawtext=${fontArg}text='${label}':x=8:y=8:fontsize=20:fontcolor=yellow`;
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', vf,
    '-frames:v', '1', out], { timeout: 30000 });
}

async function tile(frames, out, { cols = COLS, rows = ROWS, width = TILE_W, height = TILE_H } = {}) {
  // Normalise names to f00.jpg..f29.jpg in an isolated folder for the tile filter.
  const dir = path.join(path.dirname(out), '.tiles-' + process.pid + '-' + Math.random().toString(36).slice(2, 8));
  ensureDir(dir);
  try {
    for (let i = 0; i < frames.length; i++) {
      if (frames[i] && fs.existsSync(frames[i])) fs.copyFileSync(frames[i], path.join(dir, `f${String(i).padStart(2, '0')}.jpg`));
    }
    const args = ['-hide_banner', '-loglevel', 'error', '-y',
      '-framerate', '1', '-i', path.join(dir, 'f%02d.jpg'),
      '-vf', `tile=${cols}x${rows}:padding=0:margin=0`, '-frames:v', '1', '-q:v', '2', out];
    await run(FFMPEG, args, { timeout: 60000 });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Build a contact sheet.
 * @returns {{ sheet, frames, duration, count, cols, rows, timestamps }}
 */
async function contactSheet({ input, headers, duration, outPath, count = COUNT, interval = 0, maxFrames = 120,
  cols = COLS, rows, width = TILE_W, height = TILE_H, concurrency = 3, onProgress, times: explicitTimes, captions } = {}) {
  ensureDir(path.dirname(outPath));
  let dur = Number(duration) || 0;
  if (!dur || !isFinite(dur)) {
    const p = await probe(input, { headers });
    dur = p.duration;
  }
  if (!dur || !isFinite(dur)) throw new Error('cannot determine video duration');

  const font = fontFile();
  const plan = framePlan(dur, { count, interval, maxFrames, cols });
  const times = Array.isArray(explicitTimes) && explicitTimes.length ? explicitTimes.map(Number) : plan.times;
  const n = times.length;
  const gridCols = cols;
  const gridRows = rows || Math.max(1, Math.ceil(n / cols));
  const cells = gridCols * gridRows;
  const work = path.join(path.dirname(outPath), '.frames-' + process.pid + '-' + Date.now());
  ensureDir(work);
  const frames = new Array(cells).fill(null);
  const failures = [];
  let next = 0, done = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= n) return;
      const file = path.join(work, `frame-${String(i).padStart(2, '0')}.jpg`);
      try {
        const caption = Array.isArray(captions) && captions.length ? cueAt(captions, times[i]) : '';
        await grabFrame({ input, headers, t: times[i], width, height, out: file, font, caption });
        if (fs.existsSync(file) && fs.statSync(file).size > 1000) frames[i] = file;
        else failures.push(i);
      } catch (e) { failures.push(i); }
      done++;
      if (onProgress) onProgress(Math.min(0.95, (done / n) * 0.9), `sampled ${done}/${n} frames`);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, n)) }, worker));

  // Fill missing tiles with a black frame so the grid stays aligned.
  for (let i = 0; i < cells; i++) {
    if (!frames[i]) {
      const f = path.join(work, `frame-${String(i).padStart(2, '0')}.jpg`);
      const label = i < n ? `${labelFor(times[i])} n/a` : '';
      try { await blackFrame(f, width, height, label); frames[i] = f; } catch {}
    }
  }

  try {
    await tile(frames, outPath, { cols: gridCols, rows: gridRows, width, height });
  } catch (e) {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
    throw e;
  }
  try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
  if (onProgress) onProgress(1, 'sheet written');
  return {
    sheet: outPath, duration: dur, count: n, cols: gridCols, rows: gridRows,
    interval: plan.interval,
    timestamps: times.map(t => Number(t.toFixed(1))),
    failedFrames: failures.length,
  };
}

/* Download a remote file to disk (used for hosts that ignore HTTP range requests,
   e.g. video-downloads.googleusercontent.com). Returns the local path. */
async function download(input, out, { headers, onProgress, timeout = 0 } = {}) {
  ensureDir(path.dirname(out));
  const args = ['-hide_banner', '-loglevel', 'error', '-y', ...headerArgs(headers),
    ...pickyArgs(input),
    '-i', input, '-map', '0:v?', '-map', '0:a?', '-c', 'copy', out];
  await run(FFMPEG, args, { timeout: timeout || 60 * 60 * 1000 });
  if (!fs.existsSync(out) || fs.statSync(out).size < 1024) throw new Error('download produced no data');
  if (onProgress) onProgress(fs.statSync(out).size);
  return out;
}

/* Sample a sheet with a local-file retry if remote seeking fails badly. */
async function contactSheetSmart({ input, headers, outPath, duration, cacheDir, forceDownload = false,
  interval = 0, count = COUNT, maxFrames = 120, times, onProgress, concurrency = 3, captions }) {
  const hostNeedsDownload = /googleusercontent\.com/i.test(input);
  const opts = { interval, count, maxFrames, times, onProgress, concurrency, captions };
  let local = input;
  let temp = null;
  if (forceDownload || hostNeedsDownload) {
    temp = path.join(cacheDir, `media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`);
    if (onProgress) onProgress(0.05, 'downloading source');
    await download(input, temp, { headers });
    local = temp;
  }
  try {
    let result;
    try {
      result = await contactSheet({ input: local, headers, outPath, duration, ...opts });
    } catch (e) {
      if (local !== input) throw e;
      // Remote sampling failed: download once and retry locally.
      if (onProgress) onProgress(0.05, 'remote seek failed, downloading source');
      temp = path.join(cacheDir, `media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`);
      await download(input, temp, { headers });
      result = await contactSheet({ input: temp, headers, outPath, duration, ...opts });
    }
    if (result.failedFrames > Math.floor(result.count / 2) && local === input) {
      try {
        if (onProgress) onProgress(0.05, 'many dropped frames, downloading source');
        temp = path.join(cacheDir, `media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`);
        await download(input, temp, { headers });
        result = await contactSheet({ input: temp, headers, outPath, duration, ...opts });
      } catch (e) {
        // Full-source download failed (rate-limited or expired URL): keep the
        // remotely sampled sheet rather than losing the episode entirely.
        // The temp file is removed in the finally block below.
      }
    }
    return result;
  } finally {
    if (temp) { try { fs.rmSync(temp, { force: true }); } catch {} }
  }
}

/**
 * Cut a clip out of a remote (or local) stream.
 * Stream copy first; falls back to a fast H.264/AAC encode when the source
 * container/codec cannot be copied (some HLS variants).
 * `audioInput` (optional): a second input that carries the audio track —
 * YouTube serves video and audio as separate streams, so clips mux input 0's
 * video with input 1's audio instead of taking audio from the video file.
 */
async function clip({ input, audioInput, headers, audioHeaders, out, start = 0, duration = 30, reencode = false, timeout = 20 * 60 * 1000 } = {}) {
  ensureDir(path.dirname(out));
  const startS = Math.max(0, Number(start) || 0);
  const durS = Math.max(0.5, Number(duration) || 30);
  const inputArgs = audioInput
    ? ['-ss', startS.toFixed(3), ...pickyArgs(input), ...headerArgs(headers), '-i', input,
      '-ss', startS.toFixed(3), ...pickyArgs(audioInput), ...headerArgs(audioHeaders || headers), '-i', audioInput,
      '-t', durS.toFixed(3)]
    : ['-ss', startS.toFixed(3), ...pickyArgs(input), ...headerArgs(headers), '-i', input, '-t', durS.toFixed(3)];
  const copyArgs = audioInput
    ? ['-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-shortest', '-movflags', '+faststart', out]
    : ['-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', out];
  const encArgs = audioInput
    ? ['-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
      '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', out]
    : ['-map', '0:v:0?', '-map', '0:a:0?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out];
  let lastErr;
  if (!reencode) {
    try {
      await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...inputArgs, ...copyArgs], { timeout });
      if (fs.existsSync(out) && fs.statSync(out).size > 2048) {
        return { file: out, bytes: fs.statSync(out).size, mode: 'copy', start: startS, requestedDuration: durS };
      }
    } catch (e) { lastErr = e; }
  }
  try {
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...inputArgs, ...encArgs], { timeout });
  } catch (e) {
    if (lastErr) throw new Error(`clip failed (copy: ${lastErr.message}; encode: ${e.message})`);
    throw e;
  }
  if (!fs.existsSync(out) || fs.statSync(out).size < 2048) throw new Error('clip produced no data');
  return { file: out, bytes: fs.statSync(out).size, mode: 'encode', start: startS, requestedDuration: durS };
}

module.exports = {
  contactSheet, contactSheetSmart, clip, download, probe, timestamps, framePlan, planSheets, labelFor, run,
  extractFrames,
  COLS, ROWS, COUNT, TILE_W, TILE_H, fontFile,
};
