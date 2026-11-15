const { contactSheet, probe } = require('../app/lib/ffmpeg');
const path = require('path');
const fs = require('fs');
(async () => {
  const dir = path.join(__dirname, '..', 'data', 'intel', 'sheet-test');
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, 'test.mp4');
  if (!fs.existsSync(src)) {
    const { spawnSync } = require('child_process');
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
      'testsrc2=size=1280x720:rate=25:duration=60', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=60',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', src], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
  }
  const p = await probe(src);
  console.log('probe', p);
  const t0 = Date.now();
  const sheet = await contactSheet({
    input: src, outPath: path.join(dir, 'sheet.jpg'),
    onProgress: (p, m) => console.log('  ', (p * 100).toFixed(0) + '%', m),
  });
  console.log('done in', ((Date.now() - t0) / 1000).toFixed(1) + 's', sheet);
})().catch(e => { console.error(e); process.exit(1); });
