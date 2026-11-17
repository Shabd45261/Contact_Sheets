'use strict';
/* Subtitle file conversion. The providers hand us SRT (MovieBox captions) or
   VTT (CastleTV subtitle files); /api/subtitles serves whichever format was
   asked for. Parse both cue styles once, emit either. Timestamps are always
   written as hh:mm:ss(.|,)mmm — valid in both formats. */

const CUE_FULL = /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/;
const CUE_SHORT = /(^|\s)(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2})[.,](\d{1,3})/;
const SKIP_LINE = /^(WEBVTT|NOTE\b|Kind:|Language:)/i;

function seconds(h, m, s, ms) {
  return (Number(h) || 0) * 3600 + (Number(m) || 0) * 60 + (Number(s) || 0)
    + Number(String(ms || '0').padEnd(3, '0').slice(0, 3)) / 1000;
}

/* Parse SRT and VTT (both timestamp styles) into [{ start, end, text }]. */
function parseCues(input) {
  const text = String(input || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const cues = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n').map(l => l.replace(/\s+$/, ''));
    const ti = lines.findIndex(l => CUE_FULL.test(l) || CUE_SHORT.test(l));
    if (ti < 0) continue;
    let start = 0, end = 0;
    const f = CUE_FULL.exec(lines[ti]);
    if (f) {
      start = seconds(f[1], f[2], f[3], f[4]);
      end = seconds(f[5], f[6], f[7], f[8]);
    } else {
      const s = CUE_SHORT.exec(lines[ti]);
      if (!s) continue;
      start = seconds(0, s[2], s[3], s[4]);
      end = seconds(0, s[5], s[6], s[7]);
    }
    const body = lines.slice(ti + 1).filter(l => l.trim() && !SKIP_LINE.test(l)).join('\n');
    if (body && end > start) cues.push({ start, end, text: body });
  }
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  return cues;
}

function stamp(sec, sep) {
  const s = Math.max(0, Number(sec) || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = Math.floor(s % 60);
  const ms = Math.min(999, Math.round((s - Math.floor(s)) * 1000));
  const p = (n, w) => String(n).padStart(w, '0');
  return `${p(h, 2)}:${p(m, 2)}:${p(ss, 2)}${sep}${p(ms, 3)}`;
}

function cuesToSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${c.text}`)
    .join('\n\n') + (cues.length ? '\n' : '');
}

function cuesToVtt(cues) {
  return 'WEBVTT\n\n' + cues.map(c => `${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${c.text}`)
    .join('\n\n') + (cues.length ? '\n' : '');
}

function isVtt(text) {
  return /^WEBVTT/i.test(String(text || '').replace(/^\uFEFF/, '').trimStart());
}

/* Convert downloaded subtitle text to the requested format ("srt"|"vtt").
   Same format in and out is a passthrough. */
function convertSubtitle(text, format) {
  const fmt = String(format || 'srt').toLowerCase() === 'vtt' ? 'vtt' : 'srt';
  const src = isVtt(text) ? 'vtt' : 'srt';
  if (src === fmt) return String(text || '');
  return fmt === 'vtt' ? cuesToVtt(parseCues(text)) : cuesToSrt(parseCues(text));
}

module.exports = { parseCues, cuesToSrt, cuesToVtt, isVtt, convertSubtitle };
