const { CastleProvider } = require('../app/lib/providers/castle');
const { probe } = require('../app/lib/ffmpeg');
(async () => {
  const p = new CastleProvider();
  const v = await p.getVideo('6146180944568320', '6146180946042880', 1018, 2);
  const signed = v.videoUrl;
  const base = signed.split('?')[0];
  const dir = base.slice(0, base.lastIndexOf('/'));
  const tests = [
    ['signed 720', signed],
    ['unsigned img1 720 index_287', base],
    ['img1 720 index.m3u8', dir + '/index.m3u8'],
    ['img (no 1) 720 index_287', base.replace('img1.', 'img.')],
  ];
  for (const [label, url] of tests) {
    try {
      const r = await probe(url, { headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.castleapp.com/' } });
      console.log(label, 'OK', JSON.stringify(r).slice(0, 200));
    } catch (e) { console.log(label, 'FAIL', e.message.replace(/\s+/g, ' ').slice(0, 200)); }
  }
  console.log('\nvideoUrl:', signed);
})().catch(e => { console.error(e); process.exit(1); });
