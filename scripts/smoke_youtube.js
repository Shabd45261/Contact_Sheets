'use strict';
/* YouTube provider smoke test — runs the provider directly (no server needed).
   Run from the cloudstream root with the runtime env:
     . .\scripts\env.ps1; node scripts\smoke_youtube.js [query|link]
   Covers: keyword search, pasted links (watch / Shorts / youtu.be / id),
   playlist link, detail, stream pairing and ffprobe of both streams. */
const registry = require('../app/lib/providers');
const { probe } = require('../app/lib/ffmpeg');
const { parseRef } = require('../app/lib/providers/youtube');
const path = require('path');
const fs = require('fs');

const step = async (label, fn) => {
  const t = Date.now();
  try {
    const r = await fn();
    console.log(`\n[${label}] OK ${((Date.now() - t) / 1000).toFixed(1)}s`, r);
    return r;
  } catch (e) {
    console.log(`\n[${label}] FAIL ${((Date.now() - t) / 1000).toFixed(1)}s`, e.message);
    return null;
  }
};

(async () => {
  const q = process.argv[2] || 'interstellar official trailer';
  console.log('query:', q, '->', JSON.stringify(parseRef(q)));

  await step('registry', () => {
    const p = registry.list().find(x => x.id === 'youtube');
    if (!p) throw new Error('youtube not registered');
    return { id: p.id, kind: p.kind, repo: p.repo };
  });

  const provider = registry.get('youtube');

  const keyword = await step('keyword search', () => provider.search(q));
  const first = keyword && keyword.items && keyword.items[0];
  console.log('first item:', first && [first.id, first.title, first.subtitle]);

  await step('pasted watch link', () => provider.search(`https://www.youtube.com/watch?v=${first ? first.id : 'zSWdZVtXT7E'}`));
  await step('pasted shorts link', () => provider.search(`https://www.youtube.com/shorts/${first ? first.id : 'zSWdZVtXT7E'}`));
  await step('pasted youtu.be link', () => provider.search(`https://youtu.be/${first ? first.id : 'zSWdZVtXT7E'}`));
  await step('bare video id', () => provider.search(first ? first.id : 'zSWdZVtXT7E'));

  const videoId = first ? first.id : 'zSWdZVtXT7E';
  const det = await step('detail', async () => {
    const d = await provider.detail(videoId);
    return {
      title: d.title, type: d.type, year: d.year, qualities: d.qualities,
      duration: d.duration, channel: d.channel, episodes: d.seasons[0].episodes.length,
      plot: String(d.plot || '').slice(0, 80),
    };
  });

  const streams = await step('streams', () => provider.streams({ id: videoId, quality: 720 }));
  const s = streams && streams[0];
  if (s) {
    console.log('candidate:', { quality: s.quality, format: s.format, note: s.note, audio: !!s.audioUrl, videoFormatId: s.videoFormatId, audioFormatId: s.audioFormatId });
    await step('probe video stream', async () => {
      const p = await probe(s.url, { headers: s.headers });
      return { duration: p.duration, w: p.width, h: p.height, codec: p.codec, format: p.format };
    });
    if (s.audioUrl) {
      await step('probe audio stream', async () => {
        const p = await probe(s.audioUrl, { headers: s.audioHeaders });
        return { duration: p.duration, codec: p.codec, format: p.format };
      });
    }
  }

  /* yt-dlp section download (the clip path used by jobs/api). */
  await step('fetchClip (yt-dlp section)', async () => {
    const out = path.join(require('os').tmpdir(), 'smoke_yt_clip.mp4');
    const r = await provider.fetchClip({ id: videoId, start: 30, duration: 8, out });
    const p = await probe(out, {});
    return { bytes: r.bytes, mode: r.mode, duration: p.duration, codec: p.codec, out };
  });

  /* yt-dlp full download (the sheet-source path). */
  await step('fetchFile (yt-dlp full)', async () => {
    const out = path.join(require('os').tmpdir(), 'smoke_yt_full.mp4');
    const local = await provider.fetchFile({ id: videoId, out });
    const p = await probe(local, {});
    return { path: local, duration: p.duration, h: p.height, codec: p.codec, bytes: fs.statSync(local).size };
  });

  /* Caption track: parser unit check + live yt-dlp subtitle downloads. */
  await step('caption parser', () => {
    const { parseSrt, cueAt, wrapText } = require('../app/lib/captions');
    const srt = [
      '1', '00:00:01,000 --> 00:00:03,000', 'Hello there', '',
      '2', '00:00:03,000 --> 00:00:03,010', ' ', '',
      '3', '00:00:03,010 --> 00:00:06,000', 'Hello there friend', '',
    ].join('\n');
    const cues = parseSrt(srt);
    const at2 = cueAt(cues, 2);
    const at4 = cueAt(cues, 4);
    const wrapped = wrapText('a '.repeat(60), 20, 2);
    if (cues.length !== 2) throw new Error(`expected 2 cues, got ${cues.length}`);
    if (at2 !== 'Hello there' || at4 !== 'Hello there friend') throw new Error(`cueAt mismatch: ${at2} / ${at4}`);
    if (!wrapped.includes('\n')) throw new Error('wrapText did not wrap');
    return { cues: cues.length, at2, at4, wrappedLines: wrapped.split('\n').length };
  });

  /* dQw4w9WgXcQ always has a caption track; the query video may not. */
  await step('fetchCaptions (yt-dlp srt)', async () => {
    const out = path.join(require('os').tmpdir(), 'smoke_yt_caps');
    const cap = await provider.fetchCaptions({ id: 'dQw4w9WgXcQ', out });
    const cues = require('../app/lib/captions').parseSrt(fs.readFileSync(cap.file, 'utf8'));
    return { lang: cap.lang, source: cap.source, cues: cues.length, file: cap.file };
  });

  await step('fetchCaptions (video without captions)', async () => {
    const out = path.join(require('os').tmpdir(), 'smoke_yt_caps_none');
    try {
      await provider.fetchCaptions({ id: 'zSWdZVtXT7E', out });
    } catch (e) {
      if (!/no captions/i.test(e.message)) throw e;
      return { message: e.message };
    }
    throw new Error('expected a no-captions error');
  });

  /* Playlist path (slower — flat listing of up to 200 entries). Uses the
     channel's real uploads playlist (UU + channel id) so the id always exists. */
  await step('playlist detail', async () => {
    const d = await provider.detail(videoId);
    if (!d.channelId) throw new Error('no channel id in detail');
    const listId = 'UU' + String(d.channelId).slice(2);
    const pd = await provider.detail(listId);
    const first = pd.seasons[0].episodes[0];
    return {
      listId, title: pd.title, type: pd.type, episodes: pd.seasons[0].episodes.length,
      first: first && [first.number, first.title.slice(0, 50)],
    };
  });
})().catch(e => { console.error('smoke crashed:', e); process.exit(1); });
