const { CastleProvider } = require('../app/lib/providers/castle');
const { probe } = require('../app/lib/ffmpeg');
(async () => {
  const p = new CastleProvider();
  const v = await p.getVideo('6146180944568320', '6146180946042880', 1018, 2);
  try {
    const r = await probe(v.videoUrl, { headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.castleapp.com/' } });
    console.log('probe signed 720 OK', JSON.stringify(r));
  } catch (e) { console.log('probe signed 720 FAIL', e.message.replace(/\s+/g, ' ').slice(0, 300)); }
})().catch(e => { console.error(e); process.exit(1); });
