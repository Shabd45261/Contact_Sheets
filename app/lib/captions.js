'use strict';
/* Caption cues for contact sheets.
   YouTube's caption track is downloaded by the youtube provider and converted
   to SRT (yt-dlp --convert-subs srt). This module parses that SRT and answers
   "what line is on screen at time t", so the sheet engine can burn the caption
   into each sampled frame. Auto-generated tracks roll (a cue repeats the
   previous line and a 10 ms transition cue sits between lines), so cueAt picks
   the longest matching cue instead of the first one. */

const ENTITIES = [
  [/&#0*39;/g, "'"], [/&#x27;/gi, "'"], [/&quot;/gi, '"'],
  [/&lt;/gi, '<'], [/&gt;/gi, '>'], [/&amp;/gi, '&'], [/&nbsp;/gi, ' '],
];

function cleanText(input) {
  let s = String(input == null ? '' : input);
  s = s.replace(/<[^>]*>/g, '').replace(/\{\\[^}]*\}/g, '');
  for (const [re, rep] of ENTITIES) s = s.replace(re, rep);
  return s.replace(/\s+/g, ' ').trim();
}

function srtSeconds(h, m, s, ms) {
  return (Number(h) || 0) * 3600 + (Number(m) || 0) * 60 + (Number(s) || 0)
    + (Number(String(ms).padEnd(3, '0').slice(0, 3)) || 0) / 1000;
}

/* Parse SRT (or VTT that still carries hour fields) into [{start,end,text}]. */
function parseSrt(input) {
  const text = String(input || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const cues = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n').map(l => l.replace(/\s+$/, ''));
    const tIdx = lines.findIndex(l =>
      /\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}/.test(l));
    if (tIdx < 0) continue;
    const m = lines[tIdx].match(
      /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/);
    if (!m) continue;
    const start = srtSeconds(m[1], m[2], m[3], m[4]);
    const end = srtSeconds(m[5], m[6], m[7], m[8]);
    const body = cleanText(lines.slice(tIdx + 1).join(' '));
    if (body && end > start) cues.push({ start, end, text: body });
  }
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  return cues;
}

/* Caption text visible at t. Overlapping cues (auto-caption rolls, 10 ms
   transitions) resolve to the longest cue that contains t. */
function cueAt(cues, t) {
  if (!Array.isArray(cues) || !cues.length) return '';
  const at = Number(t) || 0;
  let best = null;
  for (const c of cues) {
    if (c.start > at) break;
    if (at < c.end && (!best || (c.end - c.start) >= (best.end - best.start))) best = c;
  }
  return best ? best.text : '';
}

/* Break a caption into short lines so it reads on a 320x180 tile. */
function wrapText(text, maxChars = 42, maxLines = 3) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (!line) { line = w; continue; }
    if (line.length + 1 + w.length <= maxChars) line += ' ' + w;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/\s+\S*$/, '') + '…';
    return kept.join('\n');
  }
  return lines.join('\n');
}

module.exports = { parseSrt, cueAt, wrapText, cleanText };
