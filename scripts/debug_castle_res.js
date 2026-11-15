const { CastleProvider } = require('../app/lib/providers/castle');
const { probe } = require('../app/lib/ffmpeg');
(async () => {
  const p = new CastleProvider();
  const mid = '6146180944568320';
  const ep = '6146180946042880';
  for (const res of [2, 3, 1]) {
    const v = await p.getVideo(mid, ep, 1018, res);
    console.log(`res=${res}`, v && v.permissionDenied ? 'DENIED' : (v && v.videoUrl ? 'OK ' + v.videoUrl.slice(0, 80) : JSON.stringify(v).slice(0, 200)));
  }
  const v = await p.getVideo(mid, ep, 1018, 1);
  const cands = p.freeCandidates(v.videoUrl);
  for (const c of cands) {
    try {
      const r = await probe(c.url, { headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.castleapp.com/' } });
      console.log('probe', c.quality, 'OK', r.duration, r.codec || '');
    } catch (e) { console.log('probe', c.quality, 'FAIL', e.message.slice(0, 120)); }
  }
})().catch(e => { console.error(e); process.exit(1); });
