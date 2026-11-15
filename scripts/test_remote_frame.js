const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { VegaMoviesProvider } = require('../app/lib/providers/vegamovies');

const ID = 'https://vegamovies.lease/download-final-table-season-1-hindi-dubbed-series-480p-720p-1080p-web-dl';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const outDir = path.join(__dirname, '..', 'data', 'intel', 'frame-test');
fs.mkdirSync(outDir, { recursive: true });

function headersArg(headers) {
  if (!headers) return [];
  const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
  return ['-headers', lines + '\r\n'];
}

function run(args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const p = spawn(FFMPEG, args, { windowsHide: true });
    let err = '';
    const timer = setTimeout(() => { try { p.kill(); } catch {} reject(new Error('timeout ' + timeout)); }, timeout);
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(Date.now() - t0); else reject(new Error('exit ' + code + ': ' + err.slice(-300)));
    });
  });
}

(async () => {
  const p = new VegaMoviesProvider();
  const list = await p.streams({ id: ID, episode: 1 });
  const s = list[0];
  console.log('stream', s.quality, s.format, s.url.slice(0, 80), 'size', s.size);
  const base = ['-hide_banner', '-loglevel', 'error', '-y', ...headersArg(s.headers)];
  const vf = 'scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2:color=black';
  const variants = [
    ['accurate', ['-ss', '1200', ...base, '-i', s.url, '-frames:v', '1', '-vf', vf, path.join(outDir, 'a.jpg')]],
    ['noaccurate', ['-noaccurate_seek', '-ss', '1200', ...base, '-i', s.url, '-frames:v', '1', '-vf', vf, path.join(outDir, 'b.jpg')]],
    ['noaccurate2', ['-ss', '1200', '-noaccurate_seek', ...base, '-i', s.url, '-frames:v', '1', '-vf', vf, path.join(outDir, 'c.jpg')]],
  ];
  for (const [name, args] of variants) {
    try {
      const ms = await run(args, 180000);
      const bytes = fs.existsSync(args[args.length - 1]) ? fs.statSync(args[args.length - 1]).size : 0;
      console.log(name, 'ok', ms + 'ms', bytes + 'B');
    } catch (e) { console.log(name, 'FAIL', e.message); }
  }
})().catch(e => { console.error(e); process.exit(1); });
